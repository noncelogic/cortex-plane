/**
 * Agent Lifecycle Routes — quarantine, release, safe-mode boot.
 *
 * POST /agents/:agentId/quarantine   — Freeze an agent
 * POST /agents/:agentId/release      — Release from quarantine
 * POST /agents/:agentId/boot?mode=safe — Boot in safe mode
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentIdParams {
  agentId: string
}

interface QuarantineBody {
  reason: string
}

interface ReleaseBody {
  resetCircuitBreaker?: boolean
}

interface BootQuery {
  mode?: string
}

interface BootBody {
  jobId?: string
}

// ---------------------------------------------------------------------------
// Safe-mode restrictions
// ---------------------------------------------------------------------------

export const SAFE_MODE_RESTRICTIONS = [
  "no_tools",
  "no_memory_context",
  "identity_only_system_prompt",
  "token_budget_10000",
  "single_turn_only",
] as const

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentLifecycleRouteDeps {
  lifecycleManager: AgentLifecycleManager
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentLifecycleRoutes(deps: AgentLifecycleRouteDeps) {
  const { lifecycleManager, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /agents/:agentId/quarantine — Freeze an agent
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentIdParams; Body: QuarantineBody }>(
      "/agents/:agentId/quarantine",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              reason: { type: "string", minLength: 1, maxLength: 1000 },
            },
            required: ["reason"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentIdParams; Body: QuarantineBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { reason } = request.body

        try {
          await lifecycleManager.quarantine(agentId, reason)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          if (message.includes("already quarantined")) {
            return reply.status(409).send({
              error: "conflict",
              message: `Agent ${agentId} is already quarantined`,
            })
          }

          if (message.includes("not managed")) {
            return reply.status(404).send({
              error: "not_found",
              message: `Agent ${agentId} is not currently managed`,
            })
          }

          return reply.status(400).send({
            error: "bad_request",
            message,
          })
        }

        return reply.status(200).send({
          agentId,
          state: "QUARANTINED",
          reason,
          quarantinedAt: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/release — Release from quarantine
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentIdParams; Body: ReleaseBody }>(
      "/agents/:agentId/release",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              resetCircuitBreaker: { type: "boolean" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentIdParams; Body: ReleaseBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { resetCircuitBreaker } = request.body ?? {}

        try {
          await lifecycleManager.release(agentId, { resetCircuitBreaker })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          if (message.includes("not in QUARANTINED state")) {
            return reply.status(409).send({
              error: "conflict",
              message: `Agent ${agentId} is not in QUARANTINED state`,
            })
          }

          if (message.includes("not managed")) {
            return reply.status(404).send({
              error: "not_found",
              message: `Agent ${agentId} is not currently managed`,
            })
          }

          return reply.status(500).send({
            error: "internal_error",
            message,
          })
        }

        return reply.status(200).send({
          agentId,
          state: "READY",
          releasedAt: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/boot?mode=safe — Boot in safe mode
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentIdParams; Querystring: BootQuery; Body: BootBody }>(
      "/agents/:agentId/boot",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["safe"] },
            },
          },
          body: {
            type: "object",
            properties: {
              jobId: { type: "string" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentIdParams; Querystring: BootQuery; Body: BootBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { mode } = request.query
        const { jobId } = request.body ?? {}

        if (mode !== "safe") {
          return reply.status(400).send({
            error: "bad_request",
            message: "Only mode=safe is supported",
          })
        }

        try {
          await lifecycleManager.bootSafeMode(agentId, jobId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          return reply.status(500).send({
            error: "internal_error",
            message,
          })
        }

        return reply.status(200).send({
          agentId,
          state: "SAFE_MODE",
          restrictions: [...SAFE_MODE_RESTRICTIONS],
        })
      },
    )
  }
}
