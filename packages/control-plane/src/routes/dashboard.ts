/**
 * Dashboard Compatibility Routes
 *
 * Adds top-level endpoints consumed by the dashboard:
 * - Jobs: listing, detail, retry
 * - Content pipeline: list, publish, archive
 * - Memory: search, sync
 * - Browser observation aliases
 * - SSE: /jobs/stream
 * - Dashboard aggregation: /dashboard/summary, /dashboard/activity, /dashboard/jobs-stream
 */

import type { JobStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { ContentService } from "../content/service.js"
import type { Database } from "../db/types.js"
import type { BrowserObservationService } from "../observation/service.js"

interface ListJobsQuery {
  agentId?: string
  status?: JobStatus
  limit?: number
  offset?: number
}

interface JobParams {
  jobId: string
}

interface AgentParams {
  agentId: string
}

interface ListContentQuery {
  status?: "DRAFT" | "IN_REVIEW" | "QUEUED" | "PUBLISHED"
  type?: "blog" | "social" | "newsletter" | "report"
  agentId?: string
  limit?: number
  offset?: number
}

interface ContentParams {
  id: string
}

interface PublishContentBody {
  channel?: string
}

interface SearchMemoryQuery {
  agentId: string
  query: string
  limit?: number
}

interface SyncMemoryBody {
  agentId: string
  direction?: "file_to_qdrant" | "qdrant_to_file" | "bidirectional"
}

interface BrowserScreenshotsQuery {
  limit?: number
}

interface BrowserEventsQuery {
  limit?: number
  types?: string
}

export interface DashboardRouteDeps {
  db: Kysely<Database>
  enqueueJob: (jobId: string) => Promise<void>
  observationService: BrowserObservationService
  contentService: ContentService
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return value
}

function toJobSummary(
  job: {
    id: string
    agent_id: string
    status: JobStatus
    payload: Record<string, unknown>
    created_at: Date | string
    updated_at: Date | string
    completed_at: Date | string | null
    error: Record<string, unknown> | null
  },
  agentName?: string,
) {
  const payloadType = typeof job.payload.goal_type === "string" ? job.payload.goal_type : "task"
  const rawError = job.error
  const error =
    rawError && typeof rawError === "object" && typeof rawError.message === "string"
      ? rawError.message
      : undefined
  const errorCategory =
    rawError && typeof rawError === "object" && typeof rawError.category === "string"
      ? rawError.category
      : undefined

  return {
    id: job.id,
    agentId: job.agent_id,
    agentName: agentName ?? undefined,
    status: job.status,
    type: payloadType,
    createdAt: toIso(job.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(job.updated_at),
    completedAt: toIso(job.completed_at),
    error,
    errorCategory,
  }
}

interface EventRow {
  event_type: string
  payload: Record<string, unknown>
  created_at: Date | string
  duration_ms: number | null
  tool_ref: string | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
}

const STEP_EVENT_TYPES: Record<string, (e: EventRow) => string> = {
  state_transition: (e) => {
    const to = typeof e.payload.to === "string" ? e.payload.to : "unknown"
    return `State → ${to}`
  },
  tool_call_end: (e) => `Tool: ${e.tool_ref ?? "unknown"}`,
  llm_call_end: (e) => `LLM call${e.model ? ` (${e.model})` : ""}`,
  error: (e) => (typeof e.payload.message === "string" ? e.payload.message : "Error occurred"),
}

function stepStatusForEvent(e: EventRow): "COMPLETED" | "FAILED" {
  if (e.event_type === "error") return "FAILED"
  if (e.payload && typeof e.payload === "object" && "error" in e.payload && e.payload.error)
    return "FAILED"
  return "COMPLETED"
}

function synthesizeSteps(events: EventRow[]) {
  const steps: {
    name: string
    status: "COMPLETED" | "FAILED" | "RUNNING" | "PENDING"
    startedAt: string | undefined
    completedAt: string | undefined
    durationMs: number | undefined
    worker: string | undefined
    error: string | undefined
  }[] = []

  for (const evt of events) {
    const nameFn = STEP_EVENT_TYPES[evt.event_type]
    if (!nameFn) continue

    const status = stepStatusForEvent(evt)
    const ts = toIso(evt.created_at)
    const errorMsg =
      status === "FAILED" && typeof evt.payload.message === "string"
        ? evt.payload.message
        : undefined

    steps.push({
      name: nameFn(evt),
      status,
      startedAt: ts,
      completedAt: ts,
      durationMs: evt.duration_ms ?? undefined,
      worker: undefined,
      error: errorMsg,
    })
  }

  return steps
}

const LOG_LEVEL_MAP: Record<string, "INFO" | "WARN" | "ERR" | "DEBUG"> = {
  error: "ERR",
  tool_denied: "WARN",
  tool_rate_limited: "WARN",
  cost_alert: "WARN",
  circuit_breaker_trip: "WARN",
  kill_requested: "WARN",
  state_transition: "INFO",
  tool_call_end: "INFO",
  llm_call_end: "INFO",
  message_received: "DEBUG",
  message_sent: "DEBUG",
  session_start: "INFO",
  session_end: "INFO",
  checkpoint_created: "DEBUG",
}

function eventLogMessage(evt: EventRow): string {
  if (typeof evt.payload.message === "string") return evt.payload.message
  if (evt.event_type === "tool_call_end") return `Tool call: ${evt.tool_ref ?? "unknown"}`
  if (evt.event_type === "llm_call_end") {
    const parts = ["LLM call"]
    if (evt.model) parts.push(`model=${evt.model}`)
    if (evt.tokens_in) parts.push(`in=${evt.tokens_in}`)
    if (evt.tokens_out) parts.push(`out=${evt.tokens_out}`)
    return parts.join(" ")
  }
  if (evt.event_type === "state_transition") {
    const from = typeof evt.payload.from === "string" ? evt.payload.from : "?"
    const to = typeof evt.payload.to === "string" ? evt.payload.to : "?"
    return `${from} → ${to}`
  }
  return evt.event_type.replace(/_/g, " ")
}

function synthesizeLogs(events: EventRow[]) {
  return events.map((evt) => ({
    timestamp: toIso(evt.created_at) ?? new Date().toISOString(),
    level: LOG_LEVEL_MAP[evt.event_type] ?? ("INFO" as const),
    message: eventLogMessage(evt),
  }))
}

export function dashboardRoutes(deps: DashboardRouteDeps) {
  const { db, enqueueJob, observationService, contentService } = deps

  return function register(app: FastifyInstance): void {
    app.get<{ Querystring: ListJobsQuery }>(
      "/jobs",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              agentId: { type: "string" },
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
      async (request, reply) => {
        const { agentId, status, limit = 50, offset = 0 } = request.query

        let query = db
          .selectFrom("job")
          .leftJoin("agent", "agent.id", "job.agent_id")
          .select([
            "job.id",
            "job.agent_id",
            "job.status",
            "job.payload",
            "job.created_at",
            "job.updated_at",
            "job.completed_at",
            "job.error",
            "agent.name as agent_name",
          ])
        if (agentId) query = query.where("job.agent_id", "=", agentId)
        if (status) query = query.where("job.status", "=", status)

        const rows = await query
          .orderBy("job.created_at", "desc")
          .limit(limit)
          .offset(offset)
          .execute()
        const jobs = rows.map((row) => toJobSummary(row, row.agent_name ?? undefined))

        return reply.send({
          jobs,
          pagination: {
            total: jobs.length + offset,
            limit,
            offset,
            hasMore: jobs.length === limit,
          },
        })
      },
    )

    app.get("/jobs/stream", async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack()

      const raw = reply.raw
      raw.setHeader("Content-Type", "text/event-stream")
      raw.setHeader("Cache-Control", "no-cache")
      raw.setHeader("Connection", "keep-alive")
      raw.write(": connected\n\n")

      const lastSeen = new Map<string, { status: JobStatus; updatedAt: number }>()
      let closed = false

      const sendEvent = (event: string, data: Record<string, unknown>) => {
        raw.write(`event: ${event}\n`)
        raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      const poll = async () => {
        if (closed) return
        const rows = await db
          .selectFrom("job")
          .select(["id", "status", "updated_at", "created_at", "error"])
          .orderBy("updated_at", "desc")
          .limit(200)
          .execute()

        for (const row of rows) {
          const updatedAt = new Date(row.updated_at).getTime()
          const prev = lastSeen.get(row.id)
          const error =
            row.error && typeof row.error === "object" && typeof row.error.message === "string"
              ? row.error.message
              : undefined

          if (!prev) {
            sendEvent("job:created", {
              jobId: row.id,
              status: row.status,
              timestamp: toIso(row.created_at),
              error,
            })
          } else if (prev.status !== row.status || prev.updatedAt !== updatedAt) {
            let event = "job:updated"
            if (row.status === "COMPLETED") event = "job:completed"
            else if (
              row.status === "FAILED" ||
              row.status === "TIMED_OUT" ||
              row.status === "DEAD_LETTER"
            )
              event = "job:failed"

            sendEvent(event, {
              jobId: row.id,
              status: row.status,
              timestamp: toIso(row.updated_at),
              error,
            })
          }

          lastSeen.set(row.id, { status: row.status, updatedAt })
        }

        // Prune entries for jobs no longer in the query window
        const activeIds = new Set(rows.map((r) => r.id))
        for (const id of lastSeen.keys()) {
          if (!activeIds.has(id)) lastSeen.delete(id)
        }
      }

      const pollInterval = setInterval(() => {
        void poll()
          .catch((err) => {
            _request.log.warn({ err }, "Initial jobs stream poll failed")
          })
          .catch(() => {
            // Keep stream alive even if a poll fails.
          })
      }, 2000)

      const heartbeatInterval = setInterval(() => {
        if (!closed) raw.write(": heartbeat\n\n")
      }, 15000)

      void poll().catch((err) => {
        _request.log.warn({ err }, "Initial jobs stream poll failed")
      })

      raw.on("close", () => {
        closed = true
        clearInterval(pollInterval)
        clearInterval(heartbeatInterval)
      })
    })

    app.get<{ Params: JobParams }>(
      "/jobs/:jobId",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              jobId: { type: "string", format: "uuid" },
            },
            required: ["jobId"],
          },
        },
      },
      async (request, reply) => {
        const { jobId } = request.params

        const job = await db
          .selectFrom("job")
          .selectAll()
          .where("id", "=", jobId)
          .executeTakeFirst()

        if (!job) {
          return reply.status(404).send({ error: "not_found", message: "Job not found" })
        }

        const agent = await db
          .selectFrom("agent")
          .select(["id", "name"])
          .where("id", "=", job.agent_id)
          .executeTakeFirst()

        const stepsRaw =
          job.result && typeof job.result === "object" && Array.isArray(job.result.steps)
            ? job.result.steps
            : []
        const logsRaw =
          job.result && typeof job.result === "object" && Array.isArray(job.result.logs)
            ? job.result.logs
            : []

        let steps = stepsRaw
          .filter(
            (step): step is Record<string, unknown> => typeof step === "object" && step !== null,
          )
          .map((step) => ({
            name: typeof step.name === "string" ? step.name : "step",
            status:
              step.status === "COMPLETED" ||
              step.status === "FAILED" ||
              step.status === "RUNNING" ||
              step.status === "PENDING"
                ? step.status
                : "COMPLETED",
            startedAt: typeof step.startedAt === "string" ? step.startedAt : undefined,
            completedAt: typeof step.completedAt === "string" ? step.completedAt : undefined,
            durationMs: typeof step.durationMs === "number" ? step.durationMs : undefined,
            worker: typeof step.worker === "string" ? step.worker : undefined,
            error: typeof step.error === "string" ? step.error : undefined,
          }))

        let logs = logsRaw
          .filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null,
          )
          .map((entry) => ({
            timestamp:
              typeof entry.timestamp === "string"
                ? entry.timestamp
                : (toIso(job.updated_at) ?? new Date().toISOString()),
            level:
              entry.level === "INFO" ||
              entry.level === "WARN" ||
              entry.level === "ERR" ||
              entry.level === "DEBUG"
                ? entry.level
                : "INFO",
            message: typeof entry.message === "string" ? entry.message : "",
          }))

        // When result lacks steps/logs, synthesize from agent_event records
        if (steps.length === 0 || logs.length === 0) {
          const events = await db
            .selectFrom("agent_event")
            .select([
              "event_type",
              "payload",
              "created_at",
              "duration_ms",
              "tool_ref",
              "model",
              "tokens_in",
              "tokens_out",
            ])
            .where("job_id", "=", jobId)
            .orderBy("created_at", "asc")
            .limit(200)
            .execute()

          if (steps.length === 0 && events.length > 0) {
            steps = synthesizeSteps(events)
          }
          if (logs.length === 0 && events.length > 0) {
            logs = synthesizeLogs(events)
          }
        }

        const startedAtMs = job.started_at ? new Date(job.started_at).getTime() : undefined
        const completedAtMs = job.completed_at ? new Date(job.completed_at).getTime() : undefined
        const durationMs =
          startedAtMs !== undefined && completedAtMs !== undefined
            ? Math.max(0, completedAtMs - startedAtMs)
            : undefined

        // Build structured failure reason from job.error
        const rawErr = job.error
        const failureReason =
          rawErr && typeof rawErr === "object"
            ? {
                message: typeof rawErr.message === "string" ? rawErr.message : "Unknown error",
                category: typeof rawErr.category === "string" ? rawErr.category : undefined,
              }
            : undefined

        // Token usage & execution stats from job row
        const hasUsage =
          job.tokens_in > 0 ||
          job.tokens_out > 0 ||
          job.llm_call_count > 0 ||
          job.tool_call_count > 0
        const tokenUsage = hasUsage
          ? {
              tokensIn: job.tokens_in,
              tokensOut: job.tokens_out,
              costUsd:
                job.cost_usd !== null && job.cost_usd !== undefined
                  ? Number(job.cost_usd)
                  : undefined,
              llmCallCount: job.llm_call_count,
              toolCallCount: job.tool_call_count,
            }
          : undefined

        return reply.send({
          ...toJobSummary(job),
          agentName: agent?.name ?? undefined,
          durationMs,
          startedAt: toIso(job.started_at),
          attempt: job.attempt,
          maxAttempts: job.max_attempts,
          failureReason,
          tokenUsage,
          steps,
          logs,
        })
      },
    )

    app.post<{ Params: JobParams }>(
      "/jobs/:jobId/retry",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              jobId: { type: "string", format: "uuid" },
            },
            required: ["jobId"],
          },
        },
      },
      async (request, reply) => {
        const { jobId } = request.params

        const job = await db
          .selectFrom("job")
          .select(["id", "status", "error", "started_at", "completed_at", "heartbeat_at"])
          .where("id", "=", jobId)
          .executeTakeFirst()
        if (!job) {
          return reply.status(404).send({ error: "not_found", message: "Job not found" })
        }

        const previous = {
          status: job.status,
          error: job.error,
          started_at: job.started_at,
          completed_at: job.completed_at,
          heartbeat_at: job.heartbeat_at,
        }

        await db
          .updateTable("job")
          .set({
            status: "RETRYING" as JobStatus,
            error: null,
            started_at: null,
            completed_at: null,
            heartbeat_at: null,
          })
          .where("id", "=", jobId)
          .execute()

        try {
          await enqueueJob(jobId)
        } catch (err) {
          await db
            .updateTable("job")
            .set({
              status: previous.status,
              error: previous.error,
              started_at: previous.started_at,
              completed_at: previous.completed_at,
              heartbeat_at: previous.heartbeat_at,
            })
            .where("id", "=", jobId)
            .execute()
          request.log.error({ err, jobId }, "Failed to enqueue retried job")
          return reply
            .status(503)
            .send({ error: "enqueue_failed", message: "Retry enqueue failed" })
        }

        return reply.status(202).send({ jobId, status: "retrying" })
      },
    )

    app.get<{ Querystring: ListContentQuery }>(
      "/content",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["DRAFT", "IN_REVIEW", "QUEUED", "PUBLISHED"] },
              type: { type: "string", enum: ["blog", "social", "newsletter", "report"] },
              agentId: { type: "string" },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const { status, type, agentId, limit = 50, offset = 0 } = request.query
        const { items, total } = await contentService.list({ status, type, agentId, limit, offset })
        return reply.send({
          content: items.map((item) => ({
            id: item.id,
            agentId: item.agent_id,
            title: item.title,
            body: item.body,
            type: item.type,
            status: item.status,
            channel: item.channel,
            metadata: item.metadata,
            publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null,
            archivedAt: item.archived_at ? new Date(item.archived_at).toISOString() : null,
            createdAt: new Date(item.created_at).toISOString(),
            updatedAt: new Date(item.updated_at).toISOString(),
          })),
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total,
          },
        })
      },
    )

    app.post<{ Params: ContentParams; Body: PublishContentBody }>(
      "/content/:id/publish",
      async (request, reply) => {
        const { id } = request.params
        const { channel } = request.body ?? {}
        const item = await contentService.publish(id, channel)
        if (!item) {
          return reply.status(404).send({ error: "not_found", message: "Content item not found" })
        }
        return reply.send({
          id: item.id,
          status: item.status,
          publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null,
        })
      },
    )

    app.post<{ Params: ContentParams }>("/content/:id/archive", async (request, reply) => {
      const { id } = request.params
      const item = await contentService.archive(id)
      if (!item) {
        return reply.status(404).send({ error: "not_found", message: "Content item not found" })
      }
      return reply.send({
        id: item.id,
        status: item.status,
        archivedAt: item.archived_at ? new Date(item.archived_at).toISOString() : null,
      })
    })

    app.get<{ Querystring: SearchMemoryQuery }>(
      "/memory/search",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              query: { type: "string", minLength: 1 },
              limit: { type: "number", minimum: 1, maximum: 100 },
            },
            required: ["agentId", "query"],
          },
        },
      },
      async (request, reply) => {
        const { agentId, query, limit = 20 } = request.query
        const likeQuery = `%${query}%`

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

        let q = db.selectFrom("memory_extract_message").selectAll()

        // Only filter by agent_id when a valid UUID is provided to avoid
        // Postgres "invalid input syntax for type uuid" errors (#216).
        if (UUID_RE.test(agentId)) {
          q = q.where("agent_id", "=", agentId)
        }

        const rows = await q
          .where("content", "ilike", likeQuery)
          .orderBy("occurred_at", "desc")
          .limit(limit)
          .execute()

        const now = Date.now()
        const results = rows.map((row) => ({
          id: row.id,
          type: "fact" as const,
          content: row.content,
          tags: [],
          people: [],
          projects: [],
          importance: 3 as const,
          confidence: 0.7,
          source: `session:${row.session_id}`,
          createdAt: new Date(row.occurred_at).getTime(),
          accessCount: 0,
          lastAccessedAt: now,
        }))

        return reply.send({ results })
      },
    )

    app.post<{ Body: SyncMemoryBody }>(
      "/memory/sync",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              direction: {
                type: "string",
                enum: ["file_to_qdrant", "qdrant_to_file", "bidirectional"],
              },
            },
            required: ["agentId"],
          },
        },
      },
      async (_request, reply) => {
        return reply.status(501).send({
          error: "not_implemented",
          message: "Memory sync is not yet implemented",
        })
      },
    )

    app.get<{ Params: AgentParams }>("/agents/:agentId/browser", async (request, reply) => {
      const { agentId } = request.params

      const [streamStatus, tabsResult] = await Promise.all([
        observationService.getStreamStatus(agentId).catch(() => null),
        observationService.listTabs(agentId).catch(() => null),
      ])

      const tabs = (tabsResult?.tabs ?? []).map((tab, index) => ({
        id: `${agentId}-tab-${index}`,
        title: tab.title,
        url: tab.url,
        active: tab.active,
      }))

      return reply.send({
        id: `browser-${agentId}`,
        agentId,
        vncUrl: streamStatus?.vncEndpoint?.websocketUrl ?? null,
        status: streamStatus?.vncEndpoint ? "connected" : "disconnected",
        tabs,
        latencyMs: streamStatus?.vncEndpoint ? 35 : 0,
        lastHeartbeat: new Date().toISOString(),
      })
    })

    app.get<{ Params: AgentParams; Querystring: BrowserScreenshotsQuery }>(
      "/agents/:agentId/browser/screenshots",
      async (request, reply) => {
        const { agentId } = request.params
        const limit = Math.min(Number(request.query.limit) || 50, 200)

        const rows = await db
          .selectFrom("browser_screenshot")
          .selectAll()
          .where("agent_id", "=", agentId)
          .orderBy("created_at", "desc")
          .limit(limit)
          .execute()

        const screenshots = rows.map((r) => ({
          id: r.id,
          agentId: r.agent_id,
          timestamp: new Date(r.created_at).toISOString(),
          thumbnailUrl: r.thumbnail_url,
          fullUrl: r.full_url,
          dimensions: { width: r.width, height: r.height },
        }))

        return reply.send({ screenshots })
      },
    )

    app.get<{ Params: AgentParams; Querystring: BrowserEventsQuery }>(
      "/agents/:agentId/browser/events",
      async (request, reply) => {
        const { agentId } = request.params
        const limit = Math.min(Number(request.query.limit) || 50, 200)
        const typeFilter = request.query.types?.split(",").filter(Boolean)

        let query = db.selectFrom("browser_event").selectAll().where("agent_id", "=", agentId)

        if (typeFilter && typeFilter.length > 0) {
          query = query.where("type", "in", typeFilter as never)
        }

        const rows = await query.orderBy("created_at", "desc").limit(limit).execute()

        const events = rows.map((r) => ({
          id: r.id,
          type: r.type,
          timestamp: new Date(r.created_at).toISOString(),
          ...(r.url != null && { url: r.url }),
          ...(r.selector != null && { selector: r.selector }),
          ...(r.message != null && { message: r.message }),
          ...(r.duration_ms != null && { durationMs: r.duration_ms }),
          ...(r.severity != null && { severity: r.severity }),
        }))

        return reply.send({ events })
      },
    )

    // -----------------------------------------------------------------------
    // Dashboard aggregation endpoints
    // -----------------------------------------------------------------------

    app.get("/dashboard/summary", async (_request, reply) => {
      const [agentCount, jobCount, approvalCount] = await Promise.all([
        db
          .selectFrom("agent")
          .select(sql<number>`count(*)::int`.as("count"))
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("job")
          .select(sql<number>`count(*)::int`.as("count"))
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("approval_request")
          .where("status", "=", "PENDING")
          .select(sql<number>`count(*)::int`.as("count"))
          .executeTakeFirstOrThrow(),
      ])

      return reply.send({
        totalAgents: agentCount.count,
        activeJobs: jobCount.count,
        pendingApprovals: approvalCount.count,
        memoryRecords: 0,
      })
    })

    app.get<{ Querystring: { limit?: number } }>(
      "/dashboard/activity",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              limit: { type: "number", minimum: 1, maximum: 50 },
            },
          },
        },
      },
      async (request, reply) => {
        const limit = request.query.limit ?? 10

        const rows = await db
          .selectFrom("job")
          .selectAll()
          .orderBy("created_at", "desc")
          .limit(limit)
          .execute()

        const jobs = rows.map((job) => toJobSummary(job))
        return reply.send({ activity: jobs })
      },
    )

    app.get("/dashboard/jobs-stream", async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack()

      const raw = reply.raw
      raw.setHeader("Content-Type", "text/event-stream")
      raw.setHeader("Cache-Control", "no-cache")
      raw.setHeader("Connection", "keep-alive")
      raw.write(": connected\n\n")

      const lastSeen = new Map<string, { status: JobStatus; updatedAt: number }>()
      let closed = false

      const sendEvent = (event: string, data: Record<string, unknown>) => {
        raw.write(`event: ${event}\n`)
        raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      const poll = async () => {
        if (closed) return
        const rows = await db
          .selectFrom("job")
          .select(["id", "status", "updated_at", "created_at", "error"])
          .orderBy("updated_at", "desc")
          .limit(200)
          .execute()

        for (const row of rows) {
          const updatedAt = new Date(row.updated_at).getTime()
          const prev = lastSeen.get(row.id)
          const error =
            row.error && typeof row.error === "object" && typeof row.error.message === "string"
              ? row.error.message
              : undefined

          if (!prev) {
            sendEvent("job:created", {
              jobId: row.id,
              status: row.status,
              timestamp: toIso(row.created_at),
              error,
            })
          } else if (prev.status !== row.status || prev.updatedAt !== updatedAt) {
            let event = "job:updated"
            if (row.status === "COMPLETED") event = "job:completed"
            else if (
              row.status === "FAILED" ||
              row.status === "TIMED_OUT" ||
              row.status === "DEAD_LETTER"
            )
              event = "job:failed"

            sendEvent(event, {
              jobId: row.id,
              status: row.status,
              timestamp: toIso(row.updated_at),
              error,
            })
          }

          lastSeen.set(row.id, { status: row.status, updatedAt })
        }

        const activeIds = new Set(rows.map((r) => r.id))
        for (const id of lastSeen.keys()) {
          if (!activeIds.has(id)) lastSeen.delete(id)
        }
      }

      const pollInterval = setInterval(() => {
        void poll().catch((err) => {
          _request.log.warn({ err }, "Dashboard jobs stream poll failed")
        })
      }, 2000)

      const heartbeatInterval = setInterval(() => {
        if (!closed) raw.write(": heartbeat\n\n")
      }, 15000)

      void poll().catch((err) => {
        _request.log.warn({ err }, "Dashboard jobs stream initial poll failed")
      })

      raw.on("close", () => {
        closed = true
        clearInterval(pollInterval)
        clearInterval(heartbeatInterval)
      })
    })
  }
}
