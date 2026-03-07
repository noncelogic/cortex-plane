/**
 * Agent Checkpoint Routes
 *
 * Endpoints for managing agent checkpoints and rollback:
 *   GET  /agents/:agentId/checkpoints      — list checkpoints (paginated)
 *   POST /agents/:agentId/checkpoints      — create a manual checkpoint
 *   POST /agents/:agentId/rollback         — rollback agent to a checkpoint
 */

import type { AgentStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import { computeCheckpointCrc, verifyCheckpointIntegrity } from "../lifecycle/output-validator.js"
import { createRequireAuth, createRequireRole, type PreHandler } from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

// ============================================================================
// Route types
// ============================================================================

interface AgentParams {
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

// ============================================================================
// Plugin interface & factory
// ============================================================================

export interface AgentCheckpointRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentCheckpointRoutes(deps: AgentCheckpointRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: authConfig,
    sessionService,
  })
  const requireOperator: PreHandler = createRequireRole("operator")
  const requireAdmin: PreHandler = createRequireRole("admin")

  return function register(app: FastifyInstance): void {
    // ------------------------------------------------------------------
    // GET /agents/:agentId/checkpoints — list checkpoints
    // ------------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: ListCheckpointsQuery }>(
      "/agents/:agentId/checkpoints",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
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
        request: FastifyRequest<{ Params: AgentParams; Querystring: ListCheckpointsQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { limit = 50, offset = 0 } = request.query

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
          checkpoints: checkpoints.map((c) => ({
            id: c.id,
            agentId: c.agent_id,
            jobId: c.job_id,
            label: c.label,
            stateCrc: c.state_crc,
            createdAt: c.created_at,
            createdBy: c.created_by,
          })),
          total,
        })
      },
    )

    // ------------------------------------------------------------------
    // POST /agents/:agentId/checkpoints — create a manual checkpoint
    // ------------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: CreateCheckpointBody }>(
      "/agents/:agentId/checkpoints",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              label: { type: "string" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: CreateCheckpointBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId } = request.params
        const { label } = request.body ?? {}

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Capture current state from the latest completed job's checkpoint
        const latestJob = await db
          .selectFrom("job")
          .select(["id", "checkpoint", "checkpoint_crc"])
          .where("agent_id", "=", agentId)
          .where("checkpoint", "is not", null)
          .orderBy("created_at", "desc")
          .executeTakeFirst()

        const state = (latestJob?.checkpoint as Record<string, unknown> | null) ?? {}
        const stateCrc = computeCheckpointCrc(state)

        const checkpoint = await db
          .insertInto("agent_checkpoint")
          .values({
            agent_id: agentId,
            job_id: latestJob?.id ?? null,
            label: label ?? null,
            state,
            state_crc: stateCrc,
            created_by: principal.userId,
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

    // ------------------------------------------------------------------
    // POST /agents/:agentId/rollback — rollback agent to a checkpoint
    // ------------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: RollbackBody }>(
      "/agents/:agentId/rollback",
      {
        preHandler: [requireAuth, requireAdmin],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
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
        request: FastifyRequest<{ Params: AgentParams; Body: RollbackBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId } = request.params
        const { checkpointId, restoreContext } = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
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
        const state = checkpoint.state
        if (!verifyCheckpointIntegrity(state, checkpoint.state_crc)) {
          return reply.status(409).send({
            error: "conflict",
            message: "Checkpoint integrity check failed — CRC mismatch",
          })
        }

        // 1. Quarantine the agent
        await db
          .updateTable("agent")
          .set({ status: "QUARANTINED" as AgentStatus })
          .where("id", "=", agentId)
          .execute()

        // 2. Write checkpoint state to the latest job for next execution
        const latestJob = await db
          .selectFrom("job")
          .select("id")
          .where("agent_id", "=", agentId)
          .orderBy("created_at", "desc")
          .executeTakeFirst()

        if (latestJob) {
          const jobUpdate: Record<string, unknown> = {
            checkpoint: state,
            checkpoint_crc: checkpoint.state_crc,
          }

          // 3. Optionally restore context_snapshot fields
          if (restoreContext && checkpoint.context_snapshot) {
            const snapshot = checkpoint.context_snapshot
            if (snapshot.context_window !== undefined) {
              jobUpdate.context_window = snapshot.context_window
            }
          }

          await db.updateTable("job").set(jobUpdate).where("id", "=", latestJob.id).execute()
        }

        // 4. Log rollback event
        await db
          .insertInto("agent_event")
          .values({
            agent_id: agentId,
            job_id: latestJob?.id ?? null,
            event_type: "rollback",
            payload: {
              checkpoint_id: checkpointId,
              restored_by: principal.userId,
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
