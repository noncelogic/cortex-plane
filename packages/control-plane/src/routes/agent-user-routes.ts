/**
 * Agent User Routes — CRUD for user grants, pairing codes, and access requests.
 *
 * GET    /agents/:agentId/users                       — List grants (paginated)
 * POST   /agents/:agentId/users                       — Create grant (201)
 * PATCH  /agents/:agentId/users/:grantId              — Update grant
 * DELETE /agents/:agentId/users/:grantId              — Revoke grant (soft-delete, 204)
 *
 * POST   /agents/:agentId/pairing-codes               — Generate pairing code (201)
 * GET    /agents/:agentId/pairing-codes               — List active pairing codes
 * DELETE /agents/:agentId/pairing-codes/:codeId       — Revoke pairing code (204)
 *
 * GET    /agents/:agentId/access-requests              — List access requests (paginated)
 * PATCH  /agents/:agentId/access-requests/:requestId  — Approve or deny
 * GET    /access-requests/pending-count                — Per-agent pending counts
 *
 * GET    /users/:userId                                — User profile + grants
 * POST   /pair                                         — Redeem pairing code
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import {
  AccessRequestConflictError,
  type AccessRequestService,
} from "../auth/access-request-service.js"
import type { PairingService } from "../auth/pairing-service.js"
import type { SessionService } from "../auth/session-service.js"
import type { AccessRequestStatus, Database, GrantAccessLevel } from "../db/types.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentParams {
  agentId: string
}

interface GrantParams {
  agentId: string
  grantId: string
}

interface PairingCodeParams {
  agentId: string
  codeId: string
}

interface AccessRequestParams {
  agentId: string
  requestId: string
}

interface UserParams {
  userId: string
}

interface PaginationQuery {
  limit?: number
  offset?: number
}

interface AccessRequestQuery extends PaginationQuery {
  status?: AccessRequestStatus
}

interface CreateGrantBody {
  user_account_id: string
  access_level?: GrantAccessLevel
  rate_limit?: { max_messages: number; window_seconds: number } | null
  token_budget?: { max_tokens: number; window_seconds: number } | null
  expires_at?: string | null
}

interface UpdateGrantBody {
  access_level?: GrantAccessLevel
  rate_limit?: { max_messages: number; window_seconds: number } | null
  token_budget?: { max_tokens: number; window_seconds: number } | null
}

interface PatchAccessRequestBody {
  status: "approved" | "denied"
  deny_reason?: string
}

interface PairBody {
  code: string
  channel_mapping_id: string
  user_account_id: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentUserRouteDeps {
  db: Kysely<Database>
  pairingService: PairingService
  accessRequestService: AccessRequestService
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentUserRoutes(deps: AgentUserRouteDeps) {
  const { db, pairingService, accessRequestService, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // =================================================================
    // GRANTS
    // =================================================================

    // GET /agents/:agentId/users — List active grants (paginated)
    app.get<{ Params: AgentParams; Querystring: PaginationQuery }>(
      "/agents/:agentId/users",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              offset: { type: "integer", minimum: 0, default: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: PaginationQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { limit = 50, offset = 0 } = request.query

        const baseQuery = db
          .selectFrom("agent_user_grant")
          .where("agent_id", "=", agentId)
          .where("revoked_at", "is", null)

        const [grants, countResult] = await Promise.all([
          baseQuery.selectAll().orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          baseQuery.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)
        return reply.status(200).send({ grants, total })
      },
    )

    // POST /agents/:agentId/users — Create a dashboard-invite grant
    app.post<{ Params: AgentParams; Body: CreateGrantBody }>(
      "/agents/:agentId/users",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              user_account_id: { type: "string", minLength: 1 },
              access_level: { type: "string", enum: ["read", "write"] },
              rate_limit: {
                type: ["object", "null"],
                properties: {
                  max_messages: { type: "integer" },
                  window_seconds: { type: "integer" },
                },
              },
              token_budget: {
                type: ["object", "null"],
                properties: {
                  max_tokens: { type: "integer" },
                  window_seconds: { type: "integer" },
                },
              },
              expires_at: { type: ["string", "null"] },
            },
            required: ["user_account_id"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: CreateGrantBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const body = request.body
        const principal = (request as AuthenticatedRequest).principal

        // Check for any existing grant (active or revoked)
        const existing = await db
          .selectFrom("agent_user_grant")
          .selectAll()
          .where("agent_id", "=", agentId)
          .where("user_account_id", "=", body.user_account_id)
          .executeTakeFirst()

        if (existing && !existing.revoked_at) {
          return reply.status(409).send({
            error: "conflict",
            message: "User already has an active grant for this agent",
          })
        }

        // Re-activate a previously revoked grant instead of inserting
        // (UNIQUE constraint on agent_id + user_account_id prevents duplicates)
        if (existing) {
          const grant = await db
            .updateTable("agent_user_grant")
            .set({
              access_level: body.access_level ?? "write",
              origin: "dashboard_invite" as const,
              granted_by: principal.userId,
              rate_limit: body.rate_limit ?? null,
              token_budget: body.token_budget ?? null,
              expires_at: body.expires_at ? new Date(body.expires_at) : null,
              revoked_at: null,
            })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()

          return reply.status(201).send({ grant })
        }

        const grant = await db
          .insertInto("agent_user_grant")
          .values({
            agent_id: agentId,
            user_account_id: body.user_account_id,
            access_level: body.access_level ?? "write",
            origin: "dashboard_invite",
            granted_by: principal.userId,
            rate_limit: body.rate_limit ?? null,
            token_budget: body.token_budget ?? null,
            expires_at: body.expires_at ? new Date(body.expires_at) : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        return reply.status(201).send({ grant })
      },
    )

    // PATCH /agents/:agentId/users/:grantId — Update grant
    app.patch<{ Params: GrantParams; Body: UpdateGrantBody }>(
      "/agents/:agentId/users/:grantId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              grantId: { type: "string" },
            },
            required: ["agentId", "grantId"],
          },
          body: {
            type: "object",
            properties: {
              access_level: { type: "string", enum: ["read", "write"] },
              rate_limit: {
                type: ["object", "null"],
                properties: {
                  max_messages: { type: "integer" },
                  window_seconds: { type: "integer" },
                },
              },
              token_budget: {
                type: ["object", "null"],
                properties: {
                  max_tokens: { type: "integer" },
                  window_seconds: { type: "integer" },
                },
              },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: GrantParams; Body: UpdateGrantBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId, grantId } = request.params
        const body = request.body

        const updates: Record<string, unknown> = {}
        if (body.access_level !== undefined) updates.access_level = body.access_level
        if (body.rate_limit !== undefined) updates.rate_limit = body.rate_limit
        if (body.token_budget !== undefined) updates.token_budget = body.token_budget

        if (Object.keys(updates).length === 0) {
          return reply.status(400).send({ error: "bad_request", message: "No fields to update" })
        }

        const grant = await db
          .updateTable("agent_user_grant")
          .set(updates)
          .where("id", "=", grantId)
          .where("agent_id", "=", agentId)
          .where("revoked_at", "is", null)
          .returningAll()
          .executeTakeFirst()

        if (!grant) {
          return reply.status(404).send({ error: "not_found", message: "Grant not found" })
        }

        return reply.status(200).send({ grant })
      },
    )

    // DELETE /agents/:agentId/users/:grantId — Revoke grant (soft delete)
    app.delete<{ Params: GrantParams }>(
      "/agents/:agentId/users/:grantId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              grantId: { type: "string" },
            },
            required: ["agentId", "grantId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: GrantParams }>, reply: FastifyReply) => {
        const { agentId, grantId } = request.params

        const updated = await db
          .updateTable("agent_user_grant")
          .set({ revoked_at: new Date() })
          .where("id", "=", grantId)
          .where("agent_id", "=", agentId)
          .where("revoked_at", "is", null)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "Grant not found" })
        }

        return reply.status(204).send()
      },
    )

    // =================================================================
    // PAIRING CODES
    // =================================================================

    // POST /agents/:agentId/pairing-codes — Generate a pairing code
    app.post<{ Params: AgentParams }>(
      "/agents/:agentId/pairing-codes",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        const principal = (request as AuthenticatedRequest).principal

        const result = await pairingService.generate(agentId, principal.userId)

        return reply.status(201).send({ code: result.code, expiresAt: result.expiresAt })
      },
    )

    // GET /agents/:agentId/pairing-codes — List active pairing codes
    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/pairing-codes",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const codes = await pairingService.listActive(request.params.agentId)
        return reply.status(200).send({ codes })
      },
    )

    // DELETE /agents/:agentId/pairing-codes/:codeId — Revoke a pairing code
    app.delete<{ Params: PairingCodeParams }>(
      "/agents/:agentId/pairing-codes/:codeId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              codeId: { type: "string" },
            },
            required: ["agentId", "codeId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: PairingCodeParams }>, reply: FastifyReply) => {
        const { codeId } = request.params

        await pairingService.revoke(codeId)
        return reply.status(204).send()
      },
    )

    // =================================================================
    // ACCESS REQUESTS
    // =================================================================

    // GET /agents/:agentId/access-requests — List access requests (paginated)
    app.get<{ Params: AgentParams; Querystring: AccessRequestQuery }>(
      "/agents/:agentId/access-requests",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["pending", "approved", "denied"] },
              limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
              offset: { type: "integer", minimum: 0, default: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: AccessRequestQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { status, limit = 20, offset = 0 } = request.query

        let baseQuery = db.selectFrom("access_request").where("agent_id", "=", agentId)

        if (status) {
          baseQuery = baseQuery.where("status", "=", status)
        }

        const [requests, countResult] = await Promise.all([
          baseQuery.selectAll().orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          baseQuery.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)
        return reply.status(200).send({ requests, total })
      },
    )

    // PATCH /agents/:agentId/access-requests/:requestId — Approve or deny
    app.patch<{ Params: AccessRequestParams; Body: PatchAccessRequestBody }>(
      "/agents/:agentId/access-requests/:requestId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              requestId: { type: "string" },
            },
            required: ["agentId", "requestId"],
          },
          body: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["approved", "denied"] },
              deny_reason: { type: "string" },
            },
            required: ["status"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AccessRequestParams; Body: PatchAccessRequestBody }>,
        reply: FastifyReply,
      ) => {
        const { requestId } = request.params
        const { status, deny_reason } = request.body
        const principal = (request as AuthenticatedRequest).principal

        try {
          if (status === "approved") {
            const grant = await accessRequestService.approve(requestId, principal.userId)
            return reply.status(200).send({ request: { status: "approved", grant_id: grant.id } })
          }

          await accessRequestService.deny(requestId, principal.userId, deny_reason)
          return reply.status(200).send({ request: { status: "denied" } })
        } catch (err: unknown) {
          if (err instanceof AccessRequestConflictError) {
            return reply.status(409).send({ error: "conflict", message: (err as Error).message })
          }
          throw err
        }
      },
    )

    // GET /access-requests/pending-count — Per-agent pending counts
    app.get(
      "/access-requests/pending-count",
      {
        preHandler: [requireAuth, requireOperator],
      },
      async (_request: FastifyRequest, reply: FastifyReply) => {
        const counts = await accessRequestService.pendingCounts()
        // Convert Map to plain object for JSON serialization
        const countsObj: Record<string, number> = {}
        for (const [agentId, count] of counts) {
          countsObj[agentId] = count
        }
        return reply.status(200).send({ counts: countsObj })
      },
    )

    // =================================================================
    // USER PROFILE
    // =================================================================

    // GET /users/:userId — User profile with channel mappings and grants
    app.get<{ Params: UserParams }>(
      "/users/:userId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { userId: { type: "string" } },
            required: ["userId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: UserParams }>, reply: FastifyReply) => {
        const { userId } = request.params

        const user = await db
          .selectFrom("user_account")
          .selectAll()
          .where("id", "=", userId)
          .executeTakeFirst()

        if (!user) {
          return reply.status(404).send({ error: "not_found", message: "User not found" })
        }

        const [channelMappings, grants] = await Promise.all([
          db
            .selectFrom("channel_mapping")
            .selectAll()
            .where("user_account_id", "=", userId)
            .execute(),
          db
            .selectFrom("agent_user_grant")
            .selectAll()
            .where("user_account_id", "=", userId)
            .where("revoked_at", "is", null)
            .execute(),
        ])

        return reply.status(200).send({ user, channelMappings, grants })
      },
    )

    // =================================================================
    // PAIRING (public endpoint for end-users)
    // =================================================================

    // POST /pair — Redeem a pairing code
    app.post<{ Body: PairBody }>(
      "/pair",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              code: { type: "string", minLength: 1 },
              channel_mapping_id: { type: "string", minLength: 1 },
              user_account_id: { type: "string", minLength: 1 },
            },
            required: ["code", "channel_mapping_id", "user_account_id"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: PairBody }>, reply: FastifyReply) => {
        const { code, channel_mapping_id, user_account_id } = request.body

        const result = await pairingService.redeem(code, channel_mapping_id, user_account_id)

        if (!result.success) {
          return reply.status(400).send({ error: "bad_request", message: result.message })
        }

        // Look up agent name if a grant was created
        let agentName: string | undefined
        if (result.grantId) {
          const grant = await db
            .selectFrom("agent_user_grant")
            .innerJoin("agent", "agent.id", "agent_user_grant.agent_id")
            .select("agent.name")
            .where("agent_user_grant.id", "=", result.grantId)
            .executeTakeFirst()
          agentName = grant?.name ?? undefined
        }

        return reply.status(200).send({ linked: true, agentName })
      },
    )
  }
}
