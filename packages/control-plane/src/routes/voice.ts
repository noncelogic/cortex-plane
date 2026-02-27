import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import {
  DefaultVoiceSignalingBackend,
  type VoiceLifecycleAdapter,
  type VoiceSignalingBackend,
  VoiceSignalingService,
} from "./voice-signaling.js"

interface WebRtcOfferBody {
  agentId: string
  sdp: string
}

interface VoiceAuthContext {
  sessionId: string
  agentId: string
  userAccountId: string
}

interface VoiceAuthenticatedRequest extends FastifyRequest {
  voiceAuth: VoiceAuthContext
}

export interface VoiceRouteDeps {
  db: Kysely<Database>
  signalingBackend?: VoiceSignalingBackend
  signalingService?: VoiceSignalingService
  adapters?: ReadonlyArray<VoiceLifecycleAdapter>
  tokenTtlMs?: number
  sessionTtlMs?: number
}

export function voiceRoutes(deps: VoiceRouteDeps) {
  const service =
    deps.signalingService ??
    new VoiceSignalingService({
      backend: deps.signalingBackend ?? new DefaultVoiceSignalingBackend(),
      adapters: deps.adapters,
      tokenTtlMs: deps.tokenTtlMs,
      sessionTtlMs: deps.sessionTtlMs,
    })

  return function register(app: FastifyInstance): void {
    const authHook = createVoiceSessionAuth(deps.db)

    app.post<{ Body: WebRtcOfferBody }>(
      "/voice/webrtc-offer",
      {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Fastify awaits async preHandlers
        preHandler: authHook,
        schema: {
          body: {
            type: "object",
            properties: {
              agentId: { type: "string", format: "uuid" },
              sdp: { type: "string", minLength: 1 },
            },
            required: ["agentId", "sdp"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: WebRtcOfferBody }>, reply: FastifyReply) => {
        const auth = (request as VoiceAuthenticatedRequest).voiceAuth
        const { agentId, sdp } = request.body

        if (auth.agentId !== agentId) {
          return reply.status(403).send({
            error: "forbidden",
            message: "Session does not have access to this agent",
          })
        }

        const agent = await deps.db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({
            error: "not_found",
            message: `Agent ${agentId} is not managed by this control plane`,
          })
        }

        try {
          const result = await service.exchangeOffer({
            agentId,
            userAccountId: auth.userAccountId,
            boundSessionId: auth.sessionId,
            offerSdp: sdp,
          })

          return reply.status(200).send(result)
        } catch (error) {
          request.log.error(error, "Voice signaling exchange failed")
          return reply.status(502).send({
            error: "upstream_error",
            message: error instanceof Error ? error.message : "Voice signaling exchange failed",
          })
        }
      },
    )

    app.addHook("onClose", async () => {
      await service.shutdown()
    })
  }
}

function createVoiceSessionAuth(db: Kysely<Database>) {
  return async function voiceSessionAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "Missing or invalid Authorization header",
      })
    }

    const token = authHeader.slice(7)
    if (!token) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "Empty bearer token",
      })
    }

    try {
      const session = await db
        .selectFrom("session")
        .select(["id", "agent_id", "user_account_id", "status"])
        .where("id", "=", token)
        .where("status", "=", "active")
        .executeTakeFirst()

      if (!session) {
        return reply.status(401).send({
          error: "unauthorized",
          message: "Invalid or expired session token",
        })
      }

      ;(request as VoiceAuthenticatedRequest).voiceAuth = {
        sessionId: session.id,
        agentId: session.agent_id,
        userAccountId: session.user_account_id,
      }
    } catch (error) {
      request.log.error(error, "Voice session auth lookup failed")
      return reply.status(500).send({
        error: "internal_error",
        message: "Authentication check failed",
      })
    }
  }
}
