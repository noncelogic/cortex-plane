import { randomBytes, randomUUID } from "node:crypto"

export interface VoiceIceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface VoiceSignalingExchangeInput {
  agentId: string
  userAccountId: string
  boundSessionId: string
  offerSdp: string
}

export interface VoiceSignalingExchangeResult {
  sessionId: string
  sdp: string
  iceServers?: VoiceIceServer[]
}

export interface VoiceSignalingBackendInput {
  agentId: string
  userAccountId: string
  boundSessionId: string
  voiceSessionId: string
  offerSdp: string
  ephemeralToken: string
  tokenExpiresAt: Date
}

export interface VoiceSignalingBackendResult {
  answerSdp: string
  iceServers?: VoiceIceServer[]
}

export interface VoiceSignalingBackend {
  exchangeOffer(input: VoiceSignalingBackendInput): Promise<VoiceSignalingBackendResult>
}

export type VoiceSessionStopReason = "expired" | "replaced" | "shutdown" | "stopped"

export interface VoiceSessionLifecycleEvent {
  voiceSessionId: string
  agentId: string
  sessionId: string
  userAccountId: string
  tokenExpiresAt: string
  timestamp: string
  reason?: VoiceSessionStopReason
}

export interface VoiceLifecycleAdapter {
  channelType: string
  onVoiceSessionStart?(event: VoiceSessionLifecycleEvent): Promise<void> | void
  onVoiceSessionStop?(event: VoiceSessionLifecycleEvent): Promise<void> | void
}

export interface VoiceSignalingServiceOptions {
  backend: VoiceSignalingBackend
  adapters?: ReadonlyArray<VoiceLifecycleAdapter>
  tokenTtlMs?: number
  sessionTtlMs?: number
  now?: () => number
}

interface ActiveVoiceSession {
  voiceSessionId: string
  agentId: string
  userAccountId: string
  boundSessionId: string
  tokenExpiresAt: Date
  sessionExpiresAt: Date
}

const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

export class VoiceSignalingService {
  private readonly backend: VoiceSignalingBackend
  private readonly adapters: ReadonlyArray<VoiceLifecycleAdapter>
  private readonly tokenTtlMs: number
  private readonly sessionTtlMs: number
  private readonly now: () => number

  private readonly sessionsById = new Map<string, ActiveVoiceSession>()
  private readonly sessionsByBoundSessionId = new Map<string, string>()
  private readonly sessionByEphemeralToken = new Map<string, string>()

  constructor(options: VoiceSignalingServiceOptions) {
    this.backend = options.backend
    this.adapters = options.adapters ?? []
    this.tokenTtlMs = Math.max(1_000, options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS)
    this.sessionTtlMs = Math.max(this.tokenTtlMs, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS)
    this.now = options.now ?? (() => Date.now())
  }

  async exchangeOffer(input: VoiceSignalingExchangeInput): Promise<VoiceSignalingExchangeResult> {
    await this.reapExpiredSessions()

    const existingVoiceSessionId = this.sessionsByBoundSessionId.get(input.boundSessionId)
    if (existingVoiceSessionId) {
      await this.stopSession(existingVoiceSessionId, "replaced")
    }

    const voiceSessionId = randomUUID()
    const ephemeralToken = this.generateEphemeralToken()
    const tokenExpiresAt = new Date(this.now() + this.tokenTtlMs)
    const sessionExpiresAt = new Date(this.now() + this.sessionTtlMs)

    const exchange = await this.backend.exchangeOffer({
      agentId: input.agentId,
      userAccountId: input.userAccountId,
      boundSessionId: input.boundSessionId,
      voiceSessionId,
      offerSdp: input.offerSdp,
      ephemeralToken,
      tokenExpiresAt,
    })

    const session: ActiveVoiceSession = {
      voiceSessionId,
      agentId: input.agentId,
      userAccountId: input.userAccountId,
      boundSessionId: input.boundSessionId,
      tokenExpiresAt,
      sessionExpiresAt,
    }
    this.sessionsById.set(voiceSessionId, session)
    this.sessionsByBoundSessionId.set(input.boundSessionId, voiceSessionId)
    this.sessionByEphemeralToken.set(ephemeralToken, voiceSessionId)

    await this.emitStart(session)

    return {
      sessionId: voiceSessionId,
      sdp: exchange.answerSdp,
      iceServers: exchange.iceServers,
    }
  }

  isEphemeralTokenValid(token: string): boolean {
    const sessionId = this.sessionByEphemeralToken.get(token)
    if (!sessionId) return false

    const session = this.sessionsById.get(sessionId)
    if (!session) {
      this.sessionByEphemeralToken.delete(token)
      return false
    }

    return session.tokenExpiresAt.getTime() > this.now()
  }

  async shutdown(): Promise<void> {
    const ids = [...this.sessionsById.keys()]
    for (const voiceSessionId of ids) {
      await this.stopSession(voiceSessionId, "shutdown")
    }
  }

  private async reapExpiredSessions(): Promise<void> {
    const nowMs = this.now()
    const expiredIds = [...this.sessionsById.values()]
      .filter((session) => session.sessionExpiresAt.getTime() <= nowMs)
      .map((session) => session.voiceSessionId)

    for (const voiceSessionId of expiredIds) {
      await this.stopSession(voiceSessionId, "expired")
    }
  }

  private async stopSession(voiceSessionId: string, reason: VoiceSessionStopReason): Promise<void> {
    const session = this.sessionsById.get(voiceSessionId)
    if (!session) return

    this.sessionsById.delete(voiceSessionId)
    this.sessionsByBoundSessionId.delete(session.boundSessionId)

    for (const [token, tokenSessionId] of this.sessionByEphemeralToken.entries()) {
      if (tokenSessionId === voiceSessionId) {
        this.sessionByEphemeralToken.delete(token)
      }
    }

    await this.emitStop(session, reason)
  }

  private async emitStart(session: ActiveVoiceSession): Promise<void> {
    const event: VoiceSessionLifecycleEvent = {
      voiceSessionId: session.voiceSessionId,
      agentId: session.agentId,
      sessionId: session.boundSessionId,
      userAccountId: session.userAccountId,
      tokenExpiresAt: session.tokenExpiresAt.toISOString(),
      timestamp: new Date(this.now()).toISOString(),
    }

    const notifications = this.adapters.map(async (adapter) => {
      await adapter.onVoiceSessionStart?.(event)
    })
    await Promise.allSettled(notifications)
  }

  private async emitStop(
    session: ActiveVoiceSession,
    reason: VoiceSessionStopReason,
  ): Promise<void> {
    const event: VoiceSessionLifecycleEvent = {
      voiceSessionId: session.voiceSessionId,
      agentId: session.agentId,
      sessionId: session.boundSessionId,
      userAccountId: session.userAccountId,
      tokenExpiresAt: session.tokenExpiresAt.toISOString(),
      timestamp: new Date(this.now()).toISOString(),
      reason,
    }

    const notifications = this.adapters.map(async (adapter) => {
      await adapter.onVoiceSessionStop?.(event)
    })
    await Promise.allSettled(notifications)
  }

  private generateEphemeralToken(): string {
    return `cortex_vc_1_${randomBytes(24).toString("base64url")}`
  }
}

export class DefaultVoiceSignalingBackend implements VoiceSignalingBackend {
  exchangeOffer(input: VoiceSignalingBackendInput): Promise<VoiceSignalingBackendResult> {
    return Promise.resolve({
      answerSdp: createDefaultAnswerSdp(input.offerSdp),
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        {
          urls: ["turn:turn.cortex.local:3478"],
          username: `${input.voiceSessionId}.${Math.floor(input.tokenExpiresAt.getTime() / 1000)}`,
          credential: input.ephemeralToken,
        },
      ],
    })
  }
}

function createDefaultAnswerSdp(offerSdp: string): string {
  if (offerSdp.trim().length === 0) {
    return "v=0\r\ns=cortex-voice-answer\r\nt=0 0\r\n"
  }
  return offerSdp.replace("a=setup:actpass", "a=setup:active")
}
