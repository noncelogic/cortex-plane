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
 * GET    /agents/:agentId/health — Agent health probe (#317)
 */

import { randomUUID } from "node:crypto"

import type { AgentStatus, JobStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import { HeartbeatReceiver } from "../lifecycle/health.js"
import { type HealthProbeDeps, probeAgentHealth } from "../lifecycle/health-probe.js"
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

interface PauseAgentParams {
  agentId: string
}

interface PauseAgentBody {
  reason?: string
  timeoutSeconds?: number
}

interface ResumeAgentBody {
  checkpointId?: string
  instruction?: string
}

// ---------------------------------------------------------------------------
// Health status mapping
// ---------------------------------------------------------------------------

type HealthStatus = "healthy" | "degraded" | "quarantined" | "unknown"

function mapAgentHealthStatus(status: AgentStatus): HealthStatus {
  switch (status) {
    case "ACTIVE":
      return "healthy"
    case "DISABLED":
      return "degraded"
    case "ARCHIVED":
      return "quarantined"
    default:
      return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Lifecycle state derivation (#426)
// ---------------------------------------------------------------------------

type DerivedLifecycleState = "READY" | "EXECUTING" | "DRAINING" | "TERMINATED"

/**
 * Derive a UI-facing lifecycle state from persisted agent status and whether
 * the agent currently has a running job.  The lifecycle state machine lives
 * in-memory during pod execution and is never persisted, so the API must
 * synthesise a reasonable value for the dashboard.
 */
export function deriveLifecycleState(
  status: AgentStatus,
  hasRunningJob: boolean,
): DerivedLifecycleState {
  switch (status) {
    case "ACTIVE":
      return hasRunningJob ? "EXECUTING" : "READY"
    case "DISABLED":
      return "DRAINING"
    case "ARCHIVED":
      return "TERMINATED"
    default:
      return "READY"
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  enqueueJob: (jobId: string) => Promise<void>
  sessionService?: SessionService
  lifecycleManager?: AgentLifecycleManager
  /** Partial deps for the health probe — db is shared from the top-level. */
  healthProbeDeps?: Omit<HealthProbeDeps, "db" | "lifecycleState">
}

export function agentRoutes(deps: AgentRouteDeps) {
  const { db, authConfig, enqueueJob, sessionService, lifecycleManager } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

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
      async (request: FastifyRequest<{ Querystring: ListAgentsQuery }>, reply: FastifyReply) => {
        const { status, limit = 50, offset = 0 } = request.query

        let query = db.selectFrom("agent").selectAll()
        let countQuery = db.selectFrom("agent").select(db.fn.countAll<number>().as("total"))

        if (status) {
          query = query.where("status", "=", status)
          countQuery = countQuery.where("status", "=", status)
        }

        const [agents, countResult] = await Promise.all([
          query.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)

        // Enrich with cost, health, and running job data
        const todayStart = new Date()
        todayStart.setUTCHours(0, 0, 0, 0)
        const agentIds = agents.map((a) => a.id)

        const costMap = new Map<string, number>()
        const jobMap = new Map<string, string>()
        const grantCountMap = new Map<string, number>()

        if (agents.length > 0) {
          const [costEvents, runningJobs, grantCounts] = await Promise.all([
            db
              .selectFrom("agent_event")
              .selectAll()
              .where("agent_id", "in", agentIds)
              .where("created_at", ">=", todayStart)
              .execute(),
            db
              .selectFrom("job")
              .selectAll()
              .where("agent_id", "in", agentIds)
              .where("status", "=", "RUNNING" as JobStatus)
              .execute(),
            db
              .selectFrom("agent_user_grant")
              .select(["agent_id", db.fn.countAll<number>().as("cnt")])
              .where("agent_id", "in", agentIds)
              .where("revoked_at", "is", null)
              .groupBy("agent_id")
              .execute(),
          ])

          for (const e of costEvents) {
            costMap.set(e.agent_id, (costMap.get(e.agent_id) ?? 0) + (Number(e.cost_usd) || 0))
          }

          for (const j of runningJobs) {
            if (!jobMap.has(j.agent_id)) {
              jobMap.set(j.agent_id, j.id)
            }
          }

          for (const g of grantCounts) {
            grantCountMap.set(g.agent_id, Number(g.cnt))
          }
        }

        const enrichedAgents = agents.map((a) => {
          const hasRunningJob = jobMap.has(a.id)
          const authModel = a.auth_model ?? "allowlist"
          const grantCount = grantCountMap.get(a.id) ?? 0
          const authWarnings: string[] = []
          if (authModel === "allowlist" && grantCount === 0) {
            authWarnings.push("Allowlist agent has zero grants — all messages will be denied.")
          }
          return {
            ...a,
            lifecycle_state: deriveLifecycleState(a.status, hasRunningJob),
            costToday: costMap.get(a.id) ?? 0,
            healthStatus: mapAgentHealthStatus(a.status),
            runningJobId: jobMap.get(a.id) ?? null,
            grantCount,
            authWarnings,
          }
        })

        return reply.status(200).send({
          agents: enrichedAgents,
          count: enrichedAgents.length,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + enrichedAgents.length < total,
          },
        })
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
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const agent = await db
          .selectFrom("agent")
          .selectAll()
          .where("id", "=", request.params.id)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Fetch latest job, events, running job, and active grant count in parallel
        const [latestJob, agentEvents, runningJob, grantCountRow] = await Promise.all([
          db
            .selectFrom("job")
            .selectAll()
            .where("agent_id", "=", agent.id)
            .orderBy("created_at", "desc")
            .limit(1)
            .executeTakeFirst(),
          db
            .selectFrom("agent_event")
            .selectAll()
            .where("agent_id", "=", agent.id)
            .orderBy("created_at", "desc")
            .execute(),
          db
            .selectFrom("job")
            .selectAll()
            .where("agent_id", "=", agent.id)
            .where("status", "=", "RUNNING" as JobStatus)
            .limit(1)
            .executeTakeFirst(),
          db
            .selectFrom("agent_user_grant")
            .select(db.fn.countAll<number>().as("cnt"))
            .where("agent_id", "=", agent.id)
            .where("revoked_at", "is", null)
            .executeTakeFirstOrThrow(),
        ])

        // Build cost summary
        const todayStart = new Date()
        todayStart.setUTCHours(0, 0, 0, 0)
        let totalToday = 0
        let totalAllTime = 0
        const byModel: Record<string, number> = {}

        for (const e of agentEvents) {
          const cost = Number(e.cost_usd) || 0
          totalAllTime += cost
          if (new Date(e.created_at).getTime() >= todayStart.getTime()) {
            totalToday += cost
          }
          const detailModel = e.payload?.model
          const model = typeof detailModel === "string" ? detailModel : "unknown"
          if (cost > 0) {
            byModel[model] = (byModel[model] ?? 0) + cost
          }
        }

        // Build circuit breaker state from consecutive recent failures
        let consecutiveFailures = 0
        let tripReason: string | null = null
        for (const e of agentEvents) {
          const t = e.event_type
          if (t === "error" || t === "tool_error" || t === "llm_error") {
            consecutiveFailures++
            if (!tripReason) {
              const reason = e.payload?.reason
              tripReason = typeof reason === "string" ? reason : t
            }
          } else {
            break
          }
        }

        const cbConfig = agent.resource_limits?.circuitBreaker as Record<string, number> | undefined
        const maxFailures =
          typeof cbConfig?.maxConsecutiveFailures === "number" ? cbConfig.maxConsecutiveFailures : 3
        const tripped = consecutiveFailures >= maxFailures

        const authModel = agent.auth_model ?? "allowlist"
        const grantCount = Number(grantCountRow.cnt)
        const authWarnings: string[] = []
        if (authModel === "allowlist" && grantCount === 0) {
          authWarnings.push("Allowlist agent has zero grants — all messages will be denied.")
        }

        return reply.status(200).send({
          ...agent,
          lifecycle_state: deriveLifecycleState(agent.status, !!runningJob),
          latest_job: latestJob ?? null,
          costSummary: { totalToday, totalAllTime, byModel },
          healthStatus: mapAgentHealthStatus(agent.status),
          runningJobId: runningJob?.id ?? null,
          grantCount,
          authWarnings,
          circuitBreakerState: {
            tripped,
            consecutiveFailures,
            tripReason: tripped ? tripReason : null,
          },
        })
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
      async (request: FastifyRequest<{ Body: CreateAgentBody }>, reply: FastifyReply) => {
        const body = request.body
        const slug =
          body.slug ??
          body.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")

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
    // POST /agents/:agentId/pause — pause agent execution
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: PauseAgentParams; Body: PauseAgentBody }>(
      "/agents/:agentId/pause",
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
              reason: { type: "string", maxLength: 500 },
              timeoutSeconds: { type: "number", minimum: 1, maximum: 600 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: PauseAgentParams; Body: PauseAgentBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (!lifecycleManager) {
          return reply.status(503).send({
            error: "service_unavailable",
            message: "Lifecycle manager is not available",
          })
        }

        if (!lifecycleManager.getAgentContext(agentId)) {
          return reply.status(409).send({
            error: "conflict",
            message: "Agent is not currently managed (not executing)",
          })
        }

        try {
          await lifecycleManager.pause(agentId)
        } catch (err) {
          if (err instanceof Error && err.message.includes("not in EXECUTING state")) {
            return reply.status(409).send({
              error: "conflict",
              message: err.message,
            })
          }
          throw err
        }

        return reply.status(202).send({
          agentId,
          status: "pausing",
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/resume — resume agent execution
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: PauseAgentParams; Body: ResumeAgentBody }>(
      "/agents/:agentId/resume",
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
              checkpointId: { type: "string" },
              instruction: { type: "string", maxLength: 10000 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: PauseAgentParams; Body: ResumeAgentBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (!lifecycleManager) {
          return reply.status(503).send({
            error: "service_unavailable",
            message: "Lifecycle manager is not available",
          })
        }

        if (!lifecycleManager.getAgentContext(agentId)) {
          return reply.status(409).send({
            error: "conflict",
            message: "Agent is not currently managed (not executing)",
          })
        }

        try {
          await lifecycleManager.resume(agentId)
        } catch (err) {
          if (err instanceof Error) {
            return reply.status(409).send({
              error: "conflict",
              message: err.message,
            })
          }
          throw err
        }

        return reply.status(202).send({
          agentId,
          status: "resuming",
          fromCheckpoint: request.body?.checkpointId,
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/health — Agent health probe (#317)
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.get<{ Params: PauseAgentParams }>(
      "/agents/:agentId/health",
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
        },
      },
      async (request: FastifyRequest<{ Params: PauseAgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Determine lifecycle state from the lifecycle manager (if available) or
        // fall back to a reasonable default based on DB status
        const lifecycleState =
          deps.healthProbeDeps?.heartbeatReceiver?.getHealth(agentId)?.lastLifecycleState ?? "READY"

        const probeDeps: HealthProbeDeps = {
          db,
          heartbeatReceiver: deps.healthProbeDeps?.heartbeatReceiver ?? new HeartbeatReceiver(),
          circuitBreakerState: deps.healthProbeDeps?.circuitBreakerState,
          tokenBudgetConfig: deps.healthProbeDeps?.tokenBudgetConfig,
          qdrantClient: deps.healthProbeDeps?.qdrantClient,
          mcpHealthSupervisor: deps.healthProbeDeps?.mcpHealthSupervisor,
          lifecycleState,
        }

        const result = await probeAgentHealth(agentId, probeDeps)
        return reply.status(200).send(result)
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
        if (body.channel_permissions !== undefined)
          updateValues.channel_permissions = body.channel_permissions
        if (body.status !== undefined) {
          updateValues.status = body.status
          // Reset circuit breaker history when (re-)activating an agent (#443)
          if (body.status === "ACTIVE") {
            updateValues.health_reset_at = new Date()
          }
        }

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
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        // Check for active sessions before archiving
        const sessionRow = await db
          .selectFrom("session")
          .select(db.fn.countAll().as("cnt"))
          .where("agent_id", "=", request.params.id)
          .where("status", "=", "active")
          .executeTakeFirstOrThrow()

        const activeCount = Number(sessionRow.cnt)
        if (activeCount > 0) {
          return reply.status(409).send({
            error: "active_sessions",
            message: `Cannot delete agent: ${String(activeCount)} active session${activeCount === 1 ? "" : "s"} must be ended first`,
            sessionCount: activeCount,
          })
        }

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
                  "PENDING",
                  "SCHEDULED",
                  "RUNNING",
                  "WAITING_FOR_APPROVAL",
                  "COMPLETED",
                  "FAILED",
                  "TIMED_OUT",
                  "RETRYING",
                  "DEAD_LETTER",
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

        let query = db.selectFrom("job").selectAll().where("agent_id", "=", id)

        if (status) {
          query = query.where("status", "=", status)
        }

        const jobs = await query.orderBy("created_at", "desc").limit(limit).offset(offset).execute()

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
          model: body.model ?? agent.model_config.model ?? undefined,
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
