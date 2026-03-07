/**
 * Agent Lifecycle Routes
 *
 * POST /agents/:agentId/quarantine — freeze an agent, cancel running job
 * POST /agents/:agentId/release    — release from quarantine, begin re-boot cycle
 * POST /agents/:agentId/boot       — boot in safe mode (?mode=safe)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import { InvalidTransitionError } from "../lifecycle/state-machine.js"
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

interface AgentParams {
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
// Safe-mode restrictions (returned in boot response)
// ---------------------------------------------------------------------------

const SAFE_MODE_RESTRICTIONS = [
  "no_tools",
  "no_memory_context",
  "identity_only_system_prompt",
  "token_budget_10000",
  "single_turn_only",
]

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentLifecycleRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
  lifecycleManager?: AgentLifecycleManager
}

export function agentLifecycleRoutes(deps: AgentLifecycleRouteDeps) {
  const { db, authConfig, sessionService, lifecycleManager } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /agents/:agentId/quarantine
    // -----------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: QuarantineBody }>(
      "/agents/:agentId/quarantine",
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
              reason: { type: "string", minLength: 1, maxLength: 1000 },
            },
            required: ["reason"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: QuarantineBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { reason } = request.body

        // Check agent exists in DB
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status === "QUARANTINED") {
          return reply.status(409).send({
            error: "conflict",
            message: "Agent is already quarantined",
          })
        }

        // If lifecycle manager has context, transition via state machine
        if (lifecycleManager?.getAgentContext(agentId)) {
          try {
            await lifecycleManager.quarantine(agentId, reason)
          } catch (err) {
            if (err instanceof InvalidTransitionError) {
              return reply.status(409).send({
                error: "conflict",
                message: `Cannot quarantine agent in ${err.from} state`,
              })
            }
            throw err
          }
        } else {
          // Agent not currently managed — DB-only quarantine
          await db
            .updateTable("agent")
            .set({ status: "QUARANTINED" })
            .where("id", "=", agentId)
            .execute()
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
    // POST /agents/:agentId/release
    // -----------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: ReleaseBody }>(
      "/agents/:agentId/release",
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
              resetCircuitBreaker: { type: "boolean" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: ReleaseBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { resetCircuitBreaker } = request.body ?? {}

        // Check agent exists in DB
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status !== "QUARANTINED") {
          return reply.status(409).send({
            error: "conflict",
            message: `Agent is ${agent.status}, must be QUARANTINED to release`,
          })
        }

        // If lifecycle manager has context, transition via state machine
        if (lifecycleManager?.getAgentContext(agentId)) {
          try {
            await lifecycleManager.release(agentId, resetCircuitBreaker)
          } catch (err) {
            if (err instanceof Error && err.message.includes("not in QUARANTINED state")) {
              return reply.status(409).send({
                error: "conflict",
                message: err.message,
              })
            }
            throw err
          }
        } else {
          // Agent not currently managed — DB-only release
          await db
            .updateTable("agent")
            .set({ status: "ACTIVE" })
            .where("id", "=", agentId)
            .execute()
        }

        return reply.status(200).send({
          agentId,
          state: "DRAINING",
          releasedAt: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/boot?mode=safe
    // -----------------------------------------------------------------
    app.post<{ Params: AgentParams; Querystring: BootQuery; Body: BootBody }>(
      "/agents/:agentId/boot",
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
            properties: { mode: { type: "string" } },
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
        request: FastifyRequest<{ Params: AgentParams; Querystring: BootQuery; Body: BootBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { mode } = request.query
        const { jobId } = request.body ?? {}

        if (mode !== "safe") {
          return reply.status(400).send({
            error: "bad_request",
            message: "Only mode=safe is supported. Use ?mode=safe query parameter.",
          })
        }

        if (!lifecycleManager) {
          return reply.status(503).send({
            error: "service_unavailable",
            message: "Lifecycle manager is not available",
          })
        }

        // Check agent exists in DB
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // If agent is already managed (booted), reject
        if (lifecycleManager.getAgentContext(agentId)) {
          return reply.status(409).send({
            error: "conflict",
            message: "Agent is already booted",
          })
        }

        const ctx = lifecycleManager.bootSafeMode(agentId, jobId)

        return reply.status(200).send({
          agentId,
          state: ctx.stateMachine.state,
          restrictions: SAFE_MODE_RESTRICTIONS,
        })
      },
    )
  }
}
