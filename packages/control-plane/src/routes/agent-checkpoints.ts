/**
 * Agent Checkpoint CRUD + Rollback Routes
 *
 * GET    /agents/:agentId/checkpoints  — List checkpoints (paginated)
 * POST   /agents/:agentId/checkpoints  — Create manual checkpoint
 * POST   /agents/:agentId/rollback     — Restore agent to a previous checkpoint
 */

import { crc32 } from "node:zlib"

import type { AgentStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
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

interface CheckpointParams {
  agentId: string
}

interface ListCheckpointsQuery {
  limit?: number
  offset?: number
}

interface CreateCheckpointBody {
  label?: string
}

interface RollbackBody {
  checkpointId: string
  restoreContext?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStateCrc(state: Record<string, unknown>): number {
  const serialized = JSON.stringify(state)
  return crc32(Buffer.from(serialized, "utf-8"))
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentCheckpointRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentCheckpointRoutes(deps: AgentCheckpointRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")
  const requireAdmin: PreHandler = createRequireRole("admin")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /agents/:agentId/checkpoints — List checkpoints
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.get<{ Params: CheckpointParams; Querystring: ListCheckpointsQuery }>(
      "/agents/:agentId/checkpoints",
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
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: CheckpointParams; Querystring: ListCheckpointsQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { limit = 10, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        const [checkpoints, countResult] = await Promise.all([
          db
            .selectFrom("agent_checkpoint")
            .selectAll()
            .where("agent_id", "=", agentId)
            .orderBy("created_at", "desc")
            .limit(limit)
            .offset(offset)
            .execute(),
          db
            .selectFrom("agent_checkpoint")
            .select(db.fn.countAll<number>().as("total"))
            .where("agent_id", "=", agentId)
            .executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)

        return reply.status(200).send({
          checkpoints,
          total,
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/checkpoints — Create manual checkpoint
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: CheckpointParams; Body: CreateCheckpointBody }>(
      "/agents/:agentId/checkpoints",
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
              label: { type: "string", maxLength: 255 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: CheckpointParams; Body: CreateCheckpointBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        const { agentId } = request.params

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .selectAll()
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Snapshot current agent state (latest job checkpoint if available)
        const latestJob = await db
          .selectFrom("job")
          .select(["checkpoint", "checkpoint_crc"])
          .where("agent_id", "=", agentId)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst()

        const state = (latestJob?.checkpoint as Record<string, unknown>) ?? {}
        const stateCrc = computeStateCrc(state)

        const checkpoint = await db
          .insertInto("agent_checkpoint")
          .values({
            agent_id: agentId,
            label: request.body?.label ?? null,
            state,
            state_crc: stateCrc,
            created_by: principal?.userId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        return reply.status(201).send({
          id: checkpoint.id,
          agentId: checkpoint.agent_id,
          label: checkpoint.label,
          stateCrc: checkpoint.state_crc,
          createdAt: checkpoint.created_at,
          createdBy: checkpoint.created_by,
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/rollback — Restore agent to checkpoint
    // Requires: auth + admin role
    // -----------------------------------------------------------------
    app.post<{ Params: CheckpointParams; Body: RollbackBody }>(
      "/agents/:agentId/rollback",
      {
        preHandler: [requireAuth, requireAdmin],
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
              checkpointId: { type: "string", minLength: 1 },
              restoreContext: { type: "boolean" },
            },
            required: ["checkpointId"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: CheckpointParams; Body: RollbackBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        const { agentId } = request.params
        const { checkpointId, restoreContext } = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Load target checkpoint
        const checkpoint = await db
          .selectFrom("agent_checkpoint")
          .selectAll()
          .where("id", "=", checkpointId)
          .where("agent_id", "=", agentId)
          .executeTakeFirst()

        if (!checkpoint) {
          return reply.status(404).send({
            error: "not_found",
            message: "Checkpoint not found",
          })
        }

        // Verify CRC32 integrity
        const computedCrc = computeStateCrc(checkpoint.state)
        if (computedCrc !== checkpoint.state_crc) {
          return reply.status(409).send({
            error: "conflict",
            message: "Checkpoint integrity check failed — CRC32 mismatch",
          })
        }

        // 1. Quarantine the agent
        await db
          .updateTable("agent")
          .set({ status: "QUARANTINED" as AgentStatus })
          .where("id", "=", agentId)
          .execute()

        // 2. Write checkpoint state to the latest job
        const latestJob = await db
          .selectFrom("job")
          .select("id")
          .where("agent_id", "=", agentId)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst()

        if (latestJob) {
          await db
            .updateTable("job")
            .set({
              checkpoint: checkpoint.state,
              checkpoint_crc: checkpoint.state_crc,
            })
            .where("id", "=", latestJob.id)
            .execute()
        }

        // 3. Optionally restore context_snapshot — stored on agent config
        if (restoreContext && checkpoint.context_snapshot) {
          await db
            .updateTable("agent")
            .set({ config: checkpoint.context_snapshot })
            .where("id", "=", agentId)
            .execute()
        }

        // 4. Log rollback event in approval_audit_log
        await db
          .insertInto("approval_audit_log")
          .values({
            event_type: "agent_rollback",
            actor_user_id: principal?.userId ?? null,
            details: {
              agent_id: agentId,
              checkpoint_id: checkpointId,
              restore_context: restoreContext ?? false,
            },
          })
          .execute()

        return reply.status(200).send({
          state: "QUARANTINED",
          restoredFrom: checkpointId,
        })
      },
    )
  }
}
