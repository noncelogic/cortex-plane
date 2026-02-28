/**
 * Council REST Routes
 *
 * POST /api/council/sessions            — create session
 * GET  /api/council/sessions            — list sessions (filters: status, type)
 * POST /api/council/sessions/:id/vote   — submit vote
 * POST /api/council/sessions/:id/decide — human decision (requires: auth)
 * GET  /api/council/sessions/:id/events — SSE stream for session events
 */

import type {
  CouncilSessionStatus,
  CouncilSessionType,
  CouncilVote,
} from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { CouncilService } from "../council/service.js"
import type { SessionService } from "../auth/session-service.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface CreateSessionBody {
  type: CouncilSessionType
  title: string
  context?: Record<string, unknown>
  participants?: string[]
  modelPolicy?: Record<string, unknown>
  expiresAt?: string
  ttlSeconds?: number
}

interface ListQuery {
  status?: CouncilSessionStatus
  type?: CouncilSessionType
  limit?: number
  offset?: number
}

interface SessionParams {
  id: string
}

interface VoteBody {
  voter: string
  vote: CouncilVote
  confidence?: number
  reasoning?: string
  modelUsed?: string
  tokenCost?: number
}

interface DecideBody {
  decision: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface CouncilRouteDeps {
  councilService: CouncilService
  sseManager?: SSEConnectionManager
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function councilRoutes(deps: CouncilRouteDeps) {
  const { councilService, sseManager, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /api/council/sessions — Create session
    // -----------------------------------------------------------------
    app.post<{ Body: CreateSessionBody }>(
      "/api/council/sessions",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["STANDARD", "ADVISORY", "ESCALATION"] },
              title: { type: "string", minLength: 1, maxLength: 500 },
              context: { type: "object" },
              participants: { type: "array", items: { type: "string" } },
              modelPolicy: { type: "object" },
              expiresAt: { type: "string", format: "date-time" },
              ttlSeconds: { type: "number", minimum: 60, maximum: 604800 },
            },
            required: ["type", "title"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply: FastifyReply) => {
        const body = request.body
        const principal = (request as Partial<AuthenticatedRequest>).principal
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined

        try {
          const session = await councilService.createSession({
            type: body.type,
            title: body.title,
            context: body.context,
            participants: body.participants,
            modelPolicy: body.modelPolicy,
            expiresAt,
            ttlSeconds: body.ttlSeconds,
            createdBy: principal?.userId ?? undefined,
          })

          return reply.status(201).send({
            sessionId: session.id,
            status: session.status,
            expiresAt: session.expires_at.toISOString(),
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Failed to create council session"
          request.log.error({ err }, "Failed to create council session")
          return reply.status(400).send({ error: "create_failed", message })
        }
      },
    )

    // -----------------------------------------------------------------
    // GET /api/council/sessions — List sessions
    // -----------------------------------------------------------------
    app.get<{ Querystring: ListQuery }>(
      "/api/council/sessions",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["OPEN", "DECIDED", "EXPIRED", "CANCELLED"] },
              type: { type: "string", enum: ["STANDARD", "ADVISORY", "ESCALATION"] },
              limit: { type: "number", minimum: 1, maximum: 200 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Querystring: ListQuery }>,
        reply: FastifyReply,
      ) => {
        const sessions = await councilService.listSessions({
          status: request.query.status,
          type: request.query.type,
          limit: request.query.limit,
          offset: request.query.offset,
        })
        return reply.status(200).send({ sessions })
      },
    )

    // -----------------------------------------------------------------
    // POST /api/council/sessions/:id/vote — Submit vote
    // -----------------------------------------------------------------
    app.post<{ Params: SessionParams; Body: VoteBody }>(
      "/api/council/sessions/:id/vote",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          body: {
            type: "object",
            properties: {
              voter: { type: "string", minLength: 1, maxLength: 200 },
              vote: { type: "string", enum: ["APPROVE", "REJECT", "ABSTAIN"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reasoning: { type: "string", maxLength: 2000 },
              modelUsed: { type: "string", maxLength: 200 },
              tokenCost: { type: "number", minimum: 0 },
            },
            required: ["voter", "vote"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: SessionParams; Body: VoteBody }>,
        reply: FastifyReply,
      ) => {
        const result = await councilService.submitVote(request.params.id, {
          voter: request.body.voter,
          vote: request.body.vote,
          confidence: request.body.confidence,
          reasoning: request.body.reasoning,
          modelUsed: request.body.modelUsed,
          tokenCost: request.body.tokenCost,
        })

        if (!result.success) {
          const status =
            result.error === "not_found" ? 404 : result.error === "expired" ? 410 : 409
          return reply.status(status).send({ error: result.error })
        }

        return reply.status(201).send({
          voteId: result.vote.id,
          sessionId: result.vote.session_id,
          voter: result.vote.voter,
          vote: result.vote.vote,
          confidence: result.vote.confidence,
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /api/council/sessions/:id/decide — Human decision
    // Requires: auth
    // -----------------------------------------------------------------
    app.post<{ Params: SessionParams; Body: DecideBody }>(
      "/api/council/sessions/:id/decide",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          body: {
            type: "object",
            properties: {
              decision: { type: "object" },
            },
            required: ["decision"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: SessionParams; Body: DecideBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        const result = await councilService.decide(request.params.id, {
          decision: request.body.decision,
          decidedBy: principal.userId,
        })

        if (!result.success) {
          const status =
            result.error === "not_found" ? 404 : result.error === "expired" ? 410 : 409
          return reply.status(status).send({ error: result.error })
        }

        return reply.status(200).send({
          sessionId: result.session.id,
          status: result.session.status,
          decidedAt: result.session.decided_at?.toISOString() ?? null,
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /api/council/sessions/:id/events — SSE stream
    // Requires: auth
    // -----------------------------------------------------------------
    app.get<{ Params: SessionParams }>(
      "/api/council/sessions/:id/events",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
        if (!sseManager) {
          return reply.status(503).send({ error: "sse_not_available" })
        }

        const session = await councilService.getSession(request.params.id)
        if (!session) {
          return reply.status(404).send({ error: "not_found" })
        }

        const lastEventId = (request.headers["last-event-id"] as string | undefined) ?? null
        const raw = reply.raw
        const channel = `council:${request.params.id}`
        const conn = sseManager.connect(channel, raw, lastEventId)

        request.log.info(
          { sessionId: request.params.id, connectionId: conn.connectionId, lastEventId },
          "Council SSE connection established",
        )

        reply.hijack()
      },
    )
  }
}
