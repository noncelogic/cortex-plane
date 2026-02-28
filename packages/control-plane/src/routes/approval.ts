/**
 * Approval REST Routes
 *
 * POST /jobs/:jobId/approval       — Create an approval request (requires: operator)
 * POST /approval/:id/decide        — Approve or reject by request ID (requires: approver)
 * POST /approval/token/decide      — Approve or reject by plaintext token (requires: approver)
 * GET  /approvals                   — List approval requests (requires: auth)
 * GET  /approvals/:id               — Get a single approval request (requires: auth)
 * GET  /approvals/:id/audit         — Get audit trail for an approval (requires: auth)
 * GET  /approvals/stream            — SSE stream for real-time approval events (requires: auth)
 */

import type { ApprovalStatus, RiskLevel } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { buildActorMetadata } from "../approval/audit.js"
import type { ApprovalService } from "../approval/service.js"
import type { SessionService } from "../auth/session-service.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface CreateApprovalParams {
  jobId: string
}

interface CreateApprovalBody {
  agentId: string
  actionType: string
  actionSummary: string
  actionDetail: Record<string, unknown>
  approverUserAccountId?: string
  ttlSeconds?: number
  riskLevel?: RiskLevel
  resumePayload?: Record<string, unknown>
  blastRadius?: string
}

interface DecideParams {
  id: string
}

interface DecideBody {
  decision: "APPROVED" | "REJECTED"
  channel?: string
  reason?: string
}

interface TokenDecideBody {
  token: string
  decision: "APPROVED" | "REJECTED"
  channel?: string
  reason?: string
}

interface ListQuery {
  status?: ApprovalStatus
  jobId?: string
  approverUserId?: string
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface ApprovalRouteDeps {
  approvalService: ApprovalService
  sseManager?: SSEConnectionManager
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function approvalRoutes(deps: ApprovalRouteDeps) {
  const { approvalService, sseManager, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireApprover: PreHandler = createRequireRole("approver")
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /jobs/:jobId/approval — Create an approval request
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: CreateApprovalParams; Body: CreateApprovalBody }>(
      "/jobs/:jobId/approval",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              jobId: { type: "string", format: "uuid" },
            },
            required: ["jobId"],
          },
          body: {
            type: "object",
            properties: {
              agentId: { type: "string", format: "uuid" },
              actionType: { type: "string", minLength: 1 },
              actionSummary: { type: "string", minLength: 1, maxLength: 500 },
              actionDetail: { type: "object" },
              approverUserAccountId: { type: "string", format: "uuid" },
              ttlSeconds: { type: "number", minimum: 60, maximum: 604800 },
              riskLevel: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
              resumePayload: { type: "object" },
              blastRadius: { type: "string", maxLength: 500 },
            },
            required: ["agentId", "actionType", "actionSummary", "actionDetail"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: CreateApprovalParams; Body: CreateApprovalBody }>,
        reply: FastifyReply,
      ) => {
        const { jobId } = request.params
        const body = request.body

        try {
          const created = await approvalService.createRequest({
            jobId,
            agentId: body.agentId,
            actionType: body.actionType,
            actionSummary: body.actionSummary,
            actionDetail: body.actionDetail,
            approverUserAccountId: body.approverUserAccountId,
            ttlSeconds: body.ttlSeconds,
            riskLevel: body.riskLevel,
            resumePayload: body.resumePayload,
            blastRadius: body.blastRadius,
          })

          // Broadcast SSE event
          sseManager?.broadcast(body.agentId, "agent:state", {
            agentId: body.agentId,
            timestamp: new Date().toISOString(),
            state: "WAITING_FOR_APPROVAL",
            approvalRequestId: created.approvalRequestId,
            actionSummary: body.actionSummary,
            expiresAt: created.expiresAt.toISOString(),
          })

          return reply.status(201).send({
            approvalRequestId: created.approvalRequestId,
            expiresAt: created.expiresAt.toISOString(),
            // The plaintext token is included so the caller can forward it
            // to notification channels. It is NOT persisted.
            token: created.plaintextToken,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Failed to create approval request"
          request.log.error({ err, jobId }, "Failed to create approval request")
          return reply.status(400).send({ error: "create_failed", message })
        }
      },
    )

    // -----------------------------------------------------------------
    // POST /approval/:id/decide — Decide by request ID
    // Requires: auth + approver role
    // decidedBy is derived from the authenticated principal
    // -----------------------------------------------------------------
    app.post<{ Params: DecideParams; Body: DecideBody }>(
      "/approval/:id/decide",
      {
        preHandler: [requireAuth, requireApprover],
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
              decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
              channel: { type: "string" },
              reason: { type: "string", maxLength: 1000 },
            },
            required: ["decision"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: DecideParams; Body: DecideBody }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const { decision, channel, reason } = request.body
        const principal = (request as AuthenticatedRequest).principal

        // Build full actor metadata from authenticated principal
        const actor = buildActorMetadata(
          principal,
          request.ip,
          request.headers["user-agent"] ?? "unknown",
        )

        const result = await approvalService.decide(
          id,
          decision,
          principal.userId,
          channel ?? "api",
          reason,
          actor,
        )

        if (!result.success) {
          const statusCodes: Record<string, number> = {
            not_found: 404,
            already_decided: 409,
            expired: 410,
            not_authorized: 403,
          }
          const status = statusCodes[result.error!] ?? 400
          return reply.status(status).send({ error: result.error })
        }

        // Broadcast SSE event for the decision
        const req = await approvalService.getRequest(id)
        if (req && sseManager) {
          sseManager.broadcast(req.requested_by_agent_id ?? "unknown", "agent:state", {
            agentId: req.requested_by_agent_id,
            timestamp: new Date().toISOString(),
            state: decision === "APPROVED" ? "RUNNING" : "FAILED",
            approvalRequestId: id,
            decision,
            decidedBy: principal.userId,
          })
        }

        return reply.status(200).send({
          approvalRequestId: id,
          decision,
          decidedAt: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /approval/token/decide — Decide by plaintext token
    // Requires: auth + approver role
    // decidedBy is derived from the authenticated principal
    // -----------------------------------------------------------------
    app.post<{ Body: TokenDecideBody }>(
      "/approval/token/decide",
      {
        preHandler: [requireAuth, requireApprover],
        schema: {
          body: {
            type: "object",
            properties: {
              token: { type: "string", minLength: 1 },
              decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
              channel: { type: "string" },
              reason: { type: "string", maxLength: 1000 },
            },
            required: ["token", "decision"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: TokenDecideBody }>, reply: FastifyReply) => {
        const { token, decision, channel, reason } = request.body
        const principal = (request as AuthenticatedRequest).principal

        const actor = buildActorMetadata(
          principal,
          request.ip,
          request.headers["user-agent"] ?? "unknown",
        )

        const result = await approvalService.decideByToken(
          token,
          decision,
          principal.userId,
          channel ?? "api",
          reason,
          actor,
        )

        if (!result.success) {
          const statusCodes: Record<string, number> = {
            not_found: 404,
            already_decided: 409,
            expired: 410,
            not_authorized: 403,
            invalid_token_format: 400,
          }
          const status = statusCodes[result.error!] ?? 400
          return reply.status(status).send({ error: result.error })
        }

        return reply.status(200).send({
          approvalRequestId: result.approvalRequestId,
          decision,
          decidedAt: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals — List approval requests
    // Requires: auth (any role)
    // -----------------------------------------------------------------
    app.get<{ Querystring: ListQuery }>(
      "/approvals",
      {
        preHandler: [requireAuth],
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED"],
              },
              jobId: { type: "string", format: "uuid" },
              approverUserId: { type: "string", format: "uuid" },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
        const limit = request.query.limit ?? 50
        const offset = request.query.offset ?? 0

        const requests = await approvalService.list({
          status: request.query.status,
          jobId: request.query.jobId,
          approverUserId: request.query.approverUserId,
          limit,
          offset,
        })

        // Build count query with same filters
        let countQuery = approvalService.countQuery()
        if (request.query.status) countQuery = countQuery.where("status", "=", request.query.status)
        if (request.query.jobId) countQuery = countQuery.where("job_id", "=", request.query.jobId)
        if (request.query.approverUserId)
          countQuery = countQuery.where(
            "approver_user_account_id",
            "=",
            request.query.approverUserId,
          )
        const countResult = await countQuery.executeTakeFirstOrThrow()
        const total = Number(countResult.total)

        return reply.status(200).send({
          approvals: requests,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + requests.length < total,
          },
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals/:id — Get single approval request
    // Requires: auth (any role)
    // -----------------------------------------------------------------
    app.get<{ Params: { id: string } }>(
      "/approvals/:id",
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
        },
      },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const req = await approvalService.getRequest(request.params.id)
        if (!req) {
          return reply.status(404).send({ error: "not_found" })
        }
        return reply.status(200).send(req)
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals/:id/audit — Get audit trail for an approval
    // Requires: auth (any role)
    // -----------------------------------------------------------------
    app.get<{ Params: { id: string } }>(
      "/approvals/:id/audit",
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
        },
      },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const auditEntries = await approvalService.getAuditTrail(request.params.id)
        return reply.status(200).send({ audit: auditEntries })
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals/stream — SSE for real-time approval events
    // Requires: auth (validated on connection setup, not per-event)
    // -----------------------------------------------------------------
    app.get(
      "/approvals/stream",
      { preHandler: [requireAuth] },
      async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!sseManager) {
          return reply.status(503).send({ error: "sse_not_available" })
        }

        // Use a dedicated "approvals" channel for approval SSE events
        const raw = reply.raw
        const conn = sseManager.connect("_approvals", raw)

        _request.log.info(
          { connectionId: conn.connectionId },
          "Approval SSE connection established",
        )

        reply.hijack()
      },
    )
  }
}
