/**
 * Approval REST Routes
 *
 * POST /jobs/:jobId/approval       — Create an approval request
 * POST /approval/:id/decide        — Approve or reject by request ID
 * POST /approval/token/decide      — Approve or reject by plaintext token
 * GET  /approvals                   — List approval requests (with filters)
 * GET  /approvals/:id               — Get a single approval request
 * GET  /approvals/stream            — SSE stream for real-time approval events
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

import type { ApprovalService } from "../approval/service.js"
import type { SSEConnectionManager } from "../streaming/manager.js"
import type { ApprovalStatus } from "@cortex/shared"

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
}

interface DecideParams {
  id: string
}

interface DecideBody {
  decision: "APPROVED" | "REJECTED"
  decidedBy: string
  channel?: string
  reason?: string
}

interface TokenDecideBody {
  token: string
  decision: "APPROVED" | "REJECTED"
  decidedBy: string
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
}

export function approvalRoutes(deps: ApprovalRouteDeps) {
  const { approvalService, sseManager } = deps

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /jobs/:jobId/approval — Create an approval request
    // -----------------------------------------------------------------
    app.post<{ Params: CreateApprovalParams; Body: CreateApprovalBody }>(
      "/jobs/:jobId/approval",
      {
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
    // -----------------------------------------------------------------
    app.post<{ Params: DecideParams; Body: DecideBody }>(
      "/approval/:id/decide",
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
              decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
              decidedBy: { type: "string" },
              channel: { type: "string" },
              reason: { type: "string", maxLength: 1000 },
            },
            required: ["decision", "decidedBy"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: DecideParams; Body: DecideBody }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const { decision, decidedBy, channel, reason } = request.body

        const result = await approvalService.decide(
          id,
          decision,
          decidedBy,
          channel ?? "api",
          reason,
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
            decidedBy,
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
    // -----------------------------------------------------------------
    app.post<{ Body: TokenDecideBody }>(
      "/approval/token/decide",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              token: { type: "string", minLength: 1 },
              decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
              decidedBy: { type: "string" },
              channel: { type: "string" },
              reason: { type: "string", maxLength: 1000 },
            },
            required: ["token", "decision", "decidedBy"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Body: TokenDecideBody }>,
        reply: FastifyReply,
      ) => {
        const { token, decision, decidedBy, channel, reason } = request.body

        const result = await approvalService.decideByToken(
          token,
          decision,
          decidedBy,
          channel ?? "api",
          reason,
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
    // -----------------------------------------------------------------
    app.get<{ Querystring: ListQuery }>(
      "/approvals",
      {
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
      async (
        request: FastifyRequest<{ Querystring: ListQuery }>,
        reply: FastifyReply,
      ) => {
        const requests = await approvalService.list({
          status: request.query.status,
          jobId: request.query.jobId,
          approverUserId: request.query.approverUserId,
          limit: request.query.limit,
          offset: request.query.offset,
        })

        return reply.status(200).send({ approvals: requests })
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals/:id — Get single approval request
    // -----------------------------------------------------------------
    app.get<{ Params: { id: string } }>(
      "/approvals/:id",
      {
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
      async (
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply,
      ) => {
        const req = await approvalService.getRequest(request.params.id)
        if (!req) {
          return reply.status(404).send({ error: "not_found" })
        }
        return reply.status(200).send(req)
      },
    )

    // -----------------------------------------------------------------
    // GET /approvals/stream — SSE for real-time approval events
    // -----------------------------------------------------------------
    app.get(
      "/approvals/stream",
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
