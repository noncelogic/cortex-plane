/**
 * Agent CRUD + Job Routes
 *
 * GET    /agents               — List agents (supports ?status filter)
 * GET    /agents/:id           — Get agent by ID with latest job status
 * POST   /agents               — Create agent
 * PUT    /agents/:id           — Update agent
 * DELETE /agents/:id           — Soft delete (set status=ARCHIVED)
 * GET    /agents/:id/jobs      — List jobs for agent (paginated, ?status filter)
 * POST   /agents/:id/jobs      — Create and enqueue a new job
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify"
import type { Kysely } from "kysely"

import type { AgentStatus, JobStatus } from "@cortex/shared"
import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { createRequireAuth, createRequireRole } from "../middleware/auth.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentParams {
  id: string
}

interface CreateAgentBody {
  name: string
  slug?: string
  role: string
  description?: string
  model_config?: Record<string, unknown>
  skill_config?: Record<string, unknown>
  resource_limits?: Record<string, unknown>
  channel_permissions?: Record<string, unknown>
}

interface UpdateAgentBody {
  name?: string
  role?: string
  description?: string | null
  model_config?: Record<string, unknown>
  skill_config?: Record<string, unknown>
  resource_limits?: Record<string, unknown>
  channel_permissions?: Record<string, unknown>
  status?: AgentStatus
}

interface ListAgentsQuery {
  status?: AgentStatus
  limit?: number
  offset?: number
}

interface ListJobsQuery {
  status?: JobStatus
  limit?: number
  offset?: number
}

interface CreateJobBody {
  prompt: string
  goal_type?: string
  model?: string
  priority?: number
  timeout_seconds?: number
  max_attempts?: number
  payload?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  enqueueJob: (jobId: string) => Promise<void>
}

export function agentRoutes(deps: AgentRouteDeps) {
  const { db, authConfig, enqueueJob } = deps

  const requireAuth: preHandlerHookHandler = createRequireAuth(authConfig)
  const requireOperator: preHandlerHookHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /agents — List agents
    // -----------------------------------------------------------------
    app.get<{ Querystring: ListAgentsQuery }>(
      "/agents",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ACTIVE", "DISABLED", "ARCHIVED"] },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Querystring: ListAgentsQuery }>,
        reply: FastifyReply,
      ) => {
        const { status, limit = 50, offset = 0 } = request.query

        let query = db.selectFrom("agent").selectAll()

        if (status) {
          query = query.where("status", "=", status)
        }

        const agents = await query
          .orderBy("created_at", "desc")
          .limit(limit)
          .offset(offset)
          .execute()

        return reply.status(200).send({ agents, count: agents.length })
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:id — Get agent by ID with latest job
    // -----------------------------------------------------------------
    app.get<{ Params: AgentParams }>(
      "/agents/:id",
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
        request: FastifyRequest<{ Params: AgentParams }>,
        reply: FastifyReply,
      ) => {
        const agent = await db
          .selectFrom("agent")
          .selectAll()
          .where("id", "=", request.params.id)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Fetch latest job for this agent
        const latestJob = await db
          .selectFrom("job")
          .selectAll()
          .where("agent_id", "=", agent.id)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst()

        return reply.status(200).send({ ...agent, latest_job: latestJob ?? null })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents — Create agent
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Body: CreateAgentBody }>(
      "/agents",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          body: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              slug: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+$" },
              role: { type: "string", minLength: 1, maxLength: 200 },
              description: { type: "string", maxLength: 2000 },
              model_config: { type: "object" },
              skill_config: { type: "object" },
              resource_limits: { type: "object" },
              channel_permissions: { type: "object" },
            },
            required: ["name", "role"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Body: CreateAgentBody }>,
        reply: FastifyReply,
      ) => {
        const body = request.body
        const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")

        const agent = await db
          .insertInto("agent")
          .values({
            name: body.name,
            slug,
            role: body.role,
            description: body.description ?? null,
            model_config: body.model_config ?? {},
            skill_config: body.skill_config ?? {},
            resource_limits: body.resource_limits ?? {},
            channel_permissions: body.channel_permissions ?? {},
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        return reply.status(201).send(agent)
      },
    )

    // -----------------------------------------------------------------
    // PUT /agents/:id — Update agent
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.put<{ Params: AgentParams; Body: UpdateAgentBody }>(
      "/agents/:id",
      {
        preHandler: [requireAuth, requireOperator],
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
              name: { type: "string", minLength: 1, maxLength: 200 },
              role: { type: "string", minLength: 1, maxLength: 200 },
              description: { type: ["string", "null"], maxLength: 2000 },
              model_config: { type: "object" },
              skill_config: { type: "object" },
              resource_limits: { type: "object" },
              channel_permissions: { type: "object" },
              status: { type: "string", enum: ["ACTIVE", "DISABLED", "ARCHIVED"] },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: UpdateAgentBody }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const body = request.body

        // Build update values from non-undefined body fields
        const updateValues: Record<string, unknown> = {}
        if (body.name !== undefined) updateValues.name = body.name
        if (body.role !== undefined) updateValues.role = body.role
        if (body.description !== undefined) updateValues.description = body.description
        if (body.model_config !== undefined) updateValues.model_config = body.model_config
        if (body.skill_config !== undefined) updateValues.skill_config = body.skill_config
        if (body.resource_limits !== undefined) updateValues.resource_limits = body.resource_limits
        if (body.channel_permissions !== undefined) updateValues.channel_permissions = body.channel_permissions
        if (body.status !== undefined) updateValues.status = body.status

        if (Object.keys(updateValues).length === 0) {
          return reply.status(400).send({ error: "bad_request", message: "No fields to update" })
        }

        const updated = await db
          .updateTable("agent")
          .set(updateValues)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        return reply.status(200).send(updated)
      },
    )

    // -----------------------------------------------------------------
    // DELETE /agents/:id — Soft delete (set status=ARCHIVED)
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.delete<{ Params: AgentParams }>(
      "/agents/:id",
      {
        preHandler: [requireAuth, requireOperator],
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
        request: FastifyRequest<{ Params: AgentParams }>,
        reply: FastifyReply,
      ) => {
        const updated = await db
          .updateTable("agent")
          .set({ status: "ARCHIVED" as AgentStatus })
          .where("id", "=", request.params.id)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        return reply.status(200).send(updated)
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:id/jobs — List jobs for agent
    // -----------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: ListJobsQuery }>(
      "/agents/:id/jobs",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          querystring: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: [
                  "PENDING", "SCHEDULED", "RUNNING",
                  "WAITING_FOR_APPROVAL", "COMPLETED",
                  "FAILED", "TIMED_OUT", "RETRYING", "DEAD_LETTER",
                ],
              },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: ListJobsQuery }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const { status, limit = 50, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        let query = db
          .selectFrom("job")
          .selectAll()
          .where("agent_id", "=", id)

        if (status) {
          query = query.where("status", "=", status)
        }

        const jobs = await query
          .orderBy("created_at", "desc")
          .limit(limit)
          .offset(offset)
          .execute()

        return reply.status(200).send({ jobs, count: jobs.length })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:id/jobs — Create and enqueue a new job
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: CreateJobBody }>(
      "/agents/:id/jobs",
      {
        preHandler: [requireAuth, requireOperator],
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
              prompt: { type: "string", minLength: 1, maxLength: 50_000 },
              goal_type: {
                type: "string",
                enum: ["code_edit", "code_generate", "code_review", "shell_command", "research"],
              },
              model: { type: "string", maxLength: 100 },
              priority: { type: "number", minimum: 0, maximum: 100 },
              timeout_seconds: { type: "number", minimum: 10, maximum: 3600 },
              max_attempts: { type: "number", minimum: 1, maximum: 10 },
              payload: { type: "object" },
            },
            required: ["prompt"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: CreateJobBody }>,
        reply: FastifyReply,
      ) => {
        const { id: agentId } = request.params
        const body = request.body

        // Verify agent exists and is active
        const agent = await db
          .selectFrom("agent")
          .selectAll()
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status !== "ACTIVE") {
          return reply.status(409).send({
            error: "conflict",
            message: `Agent is ${agent.status}, must be ACTIVE to accept jobs`,
          })
        }

        const jobId = randomUUID()

        // Build payload that includes the prompt and goal info
        const payload: Record<string, unknown> = {
          prompt: body.prompt,
          goal_type: body.goal_type ?? "research",
          model: body.model ?? (agent.model_config as Record<string, unknown>).model ?? undefined,
          ...(body.payload ?? {}),
        }

        // Insert job
        const job = await db
          .insertInto("job")
          .values({
            id: jobId,
            agent_id: agentId,
            session_id: null,
            payload,
            priority: body.priority ?? 0,
            timeout_seconds: body.timeout_seconds ?? 300,
            max_attempts: body.max_attempts ?? 3,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        // Transition to SCHEDULED and enqueue
        await db
          .updateTable("job")
          .set({ status: "SCHEDULED" as JobStatus })
          .where("id", "=", jobId)
          .execute()

        try {
          await enqueueJob(jobId)
        } catch (err) {
          request.log.error({ err, jobId }, "Failed to enqueue job via Graphile Worker")
          // Job is in the DB as SCHEDULED — the worker cron will pick it up
        }

        return reply.status(201).send({
          ...job,
          status: "SCHEDULED",
        })
      },
    )
  }
}
