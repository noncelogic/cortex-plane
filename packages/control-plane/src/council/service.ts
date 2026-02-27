/**
 * CouncilService — core council session logic.
 *
 * Responsibilities:
 * - Create sessions
 * - Accept votes
 * - Record human decisions
 * - Expire stale sessions
 * - Persist and broadcast events
 */

import type { CouncilSessionStatus, CouncilSessionType, CouncilVote } from "@cortex/shared"
import { withSpan } from "@cortex/shared/tracing"
import type { Kysely } from "kysely"

import type {
  CouncilEvent,
  CouncilSession,
  CouncilVoteRecord,
  Database,
} from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"
import type { SSEEventType } from "../streaming/types.js"

export interface CouncilServiceDeps {
  db: Kysely<Database>
  sseManager?: SSEConnectionManager
}

export interface CreateCouncilSessionInput {
  type: CouncilSessionType
  title: string
  context?: Record<string, unknown>
  participants?: string[]
  modelPolicy?: Record<string, unknown>
  expiresAt?: Date
  ttlSeconds?: number
  createdBy?: string
}

export interface SubmitCouncilVoteInput {
  voter: string
  vote: CouncilVote
  confidence?: number | null
  reasoning?: string | null
  modelUsed?: string | null
  tokenCost?: number | null
}

export interface DecideCouncilInput {
  decision: Record<string, unknown>
  decidedBy: string
}

export type CouncilDecisionResult =
  | { success: true; session: CouncilSession }
  | { success: false; error: "not_found" | "not_open" | "expired" }

export type CouncilVoteResult =
  | { success: true; vote: CouncilVoteRecord; session: CouncilSession }
  | { success: false; error: "not_found" | "not_open" | "expired" }

type CouncilEventType = "created" | "vote" | "decided" | "expired"

const DEFAULT_TTL_SECONDS = 86_400

const COUNCIL_EVENT_TO_SSE: Record<CouncilEventType, SSEEventType> = {
  created: "council:created",
  vote: "council:vote",
  decided: "council:decided",
  expired: "council:expired",
}

export class CouncilService {
  private readonly db: Kysely<Database>
  private readonly sseManager?: SSEConnectionManager

  constructor(deps: CouncilServiceDeps) {
    this.db = deps.db
    this.sseManager = deps.sseManager
  }

  async createSession(input: CreateCouncilSessionInput): Promise<CouncilSession> {
    return withSpan("cortex.council.create", async (span) => {
      span.setAttribute("cortex.council.type", input.type)

      const expiresAt = resolveExpiry(input.expiresAt, input.ttlSeconds)
      const now = new Date()
      if (expiresAt <= now) {
        throw new Error("expires_at_must_be_future")
      }

      let session: CouncilSession | undefined

      await this.db.transaction().execute(async (tx) => {
        session = await tx
          .insertInto("council_sessions")
          .values({
            type: input.type,
            status: "OPEN",
            title: input.title,
            context: input.context ?? {},
            participants: input.participants ?? [],
            decision: null,
            decided_by: null,
            decided_at: null,
            expires_at: expiresAt,
            model_policy: input.modelPolicy ?? {},
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        await this.insertEvent(tx, session!.id, "created", {
          sessionId: session!.id,
          type: session!.type,
          title: session!.title,
          createdBy: input.createdBy ?? null,
          timestamp: now.toISOString(),
        })
      })

      await this.broadcastEvent(session!, "created", {
        sessionId: session!.id,
        type: session!.type,
        status: session!.status,
        title: session!.title,
        timestamp: now.toISOString(),
      })

      return session!
    })
  }

  async listSessions(filters?: {
    status?: CouncilSessionStatus
    type?: CouncilSessionType
    limit?: number
    offset?: number
  }): Promise<CouncilSession[]> {
    let q = this.db.selectFrom("council_sessions").selectAll()
    if (filters?.status) q = q.where("status", "=", filters.status)
    if (filters?.type) q = q.where("type", "=", filters.type)
    q = q.orderBy("created_at", "desc").limit(filters?.limit ?? 50)
    if (filters?.offset) q = q.offset(filters.offset)
    return q.execute()
  }

  async submitVote(sessionId: string, input: SubmitCouncilVoteInput): Promise<CouncilVoteResult> {
    return withSpan("cortex.council.vote", async (span) => {
      span.setAttribute("cortex.council.session_id", sessionId)
      span.setAttribute("cortex.council.voter", input.voter)

      const session = await this.getSession(sessionId)
      if (!session) return { success: false, error: "not_found" }

      const expired = await this.expireIfNeeded(session)
      if (expired) return { success: false, error: "expired" }

      if (session.status !== "OPEN") return { success: false, error: "not_open" }

      const now = new Date()
      const vote = await this.db
        .insertInto("council_votes")
        .values({
          session_id: sessionId,
          voter: input.voter,
          vote: input.vote,
          confidence: input.confidence ?? null,
          reasoning: input.reasoning ?? null,
          model_used: input.modelUsed ?? null,
          token_cost: input.tokenCost ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["session_id", "voter"]).doUpdateSet({
            vote: input.vote,
            confidence: input.confidence ?? null,
            reasoning: input.reasoning ?? null,
            model_used: input.modelUsed ?? null,
            token_cost: input.tokenCost ?? null,
            updated_at: now,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.db
        .updateTable("council_sessions")
        .set({ updated_at: now })
        .where("id", "=", sessionId)
        .execute()

      await this.insertEvent(this.db, sessionId, "vote", {
        sessionId,
        voter: input.voter,
        vote: input.vote,
        confidence: input.confidence ?? null,
        timestamp: now.toISOString(),
      })

      await this.broadcastEvent(session, "vote", {
        sessionId,
        voter: input.voter,
        vote: input.vote,
        confidence: input.confidence ?? null,
        timestamp: now.toISOString(),
      })

      return { success: true, vote, session }
    })
  }

  async decide(sessionId: string, input: DecideCouncilInput): Promise<CouncilDecisionResult> {
    return withSpan("cortex.council.decide", async (span) => {
      span.setAttribute("cortex.council.session_id", sessionId)
      span.setAttribute("cortex.council.decided_by", input.decidedBy)

      const session = await this.getSession(sessionId)
      if (!session) return { success: false, error: "not_found" }

      const expired = await this.expireIfNeeded(session)
      if (expired) return { success: false, error: "expired" }

      if (session.status !== "OPEN") return { success: false, error: "not_open" }

      const now = new Date()
      const updated = await this.db
        .updateTable("council_sessions")
        .set({
          status: "DECIDED",
          decision: input.decision,
          decided_by: input.decidedBy,
          decided_at: now,
          updated_at: now,
        })
        .where("id", "=", sessionId)
        .where("status", "=", "OPEN")
        .returningAll()
        .executeTakeFirst()

      if (!updated) {
        return { success: false, error: "not_open" }
      }

      await this.insertEvent(this.db, sessionId, "decided", {
        sessionId,
        decidedBy: input.decidedBy,
        decision: input.decision,
        timestamp: now.toISOString(),
      })

      await this.broadcastEvent(updated, "decided", {
        sessionId,
        decidedBy: input.decidedBy,
        decision: input.decision,
        timestamp: now.toISOString(),
      })

      return { success: true, session: updated }
    })
  }

  async expireStaleSessions(): Promise<number> {
    const now = new Date()

    const expired = await this.db
      .selectFrom("council_sessions")
      .select(["id"])
      .where("status", "=", "OPEN")
      .where("expires_at", "<", now)
      .execute()

    for (const session of expired) {
      const updated = await this.db
        .updateTable("council_sessions")
        .set({ status: "EXPIRED", updated_at: now })
        .where("id", "=", session.id)
        .where("status", "=", "OPEN")
        .returningAll()
        .executeTakeFirst()

      if (updated) {
        await this.insertEvent(this.db, session.id, "expired", {
          sessionId: session.id,
          timestamp: now.toISOString(),
        })

        await this.broadcastEvent(updated, "expired", {
          sessionId: session.id,
          timestamp: now.toISOString(),
        })
      }
    }

    return expired.length
  }

  async getSession(sessionId: string): Promise<CouncilSession | undefined> {
    return this.db
      .selectFrom("council_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst()
  }

  private async expireIfNeeded(session: CouncilSession): Promise<boolean> {
    if (session.status !== "OPEN") return false
    if (session.expires_at > new Date()) return false

    const updated = await this.db
      .updateTable("council_sessions")
      .set({ status: "EXPIRED", updated_at: new Date() })
      .where("id", "=", session.id)
      .where("status", "=", "OPEN")
      .returningAll()
      .executeTakeFirst()

    if (updated) {
      await this.insertEvent(this.db, session.id, "expired", {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
      })

      await this.broadcastEvent(updated, "expired", {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
      })
    }

    return true
  }

  private async insertEvent(
    db: Kysely<Database>,
    sessionId: string,
    eventType: CouncilEventType,
    payload: Record<string, unknown>,
  ): Promise<CouncilEvent> {
    return db
      .insertInto("council_events")
      .values({
        session_id: sessionId,
        event_type: eventType,
        payload,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  private async broadcastEvent(
    session: CouncilSession,
    eventType: CouncilEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.sseManager) return
    const channel = `council:${session.id}`
    const sseEventType = COUNCIL_EVENT_TO_SSE[eventType]
    this.sseManager.broadcast(channel, sseEventType, payload)
  }
}

function resolveExpiry(expiresAt?: Date, ttlSeconds?: number): Date {
  if (expiresAt) return expiresAt
  const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS
  return new Date(Date.now() + ttl * 1000)
}
