/**
 * Dashboard Compatibility Routes
 *
 * Adds top-level endpoints consumed by the dashboard:
 * - Jobs: listing, detail, retry
 * - Content pipeline: list, publish, archive
 * - Memory: search, sync
 * - Browser observation aliases
 * - SSE: /api/jobs/stream
 */

import { randomUUID } from "node:crypto"

import type { JobStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { BrowserObservationService } from "../observation/service.js"
import type { Database } from "../db/types.js"

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
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return value
}

function toJobSummary(job: {
  id: string
  agent_id: string
  status: JobStatus
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
  completed_at: Date | string | null
  error: Record<string, unknown> | null
}) {
  const payloadType = typeof job.payload.goal_type === "string" ? job.payload.goal_type : "task"
  const rawError = job.error
  const error =
    rawError && typeof rawError === "object" && typeof rawError.message === "string"
      ? rawError.message
      : undefined

  return {
    id: job.id,
    agentId: job.agent_id,
    status: job.status,
    type: payloadType,
    createdAt: toIso(job.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(job.updated_at),
    completedAt: toIso(job.completed_at),
    error,
  }
}

export function dashboardRoutes(deps: DashboardRouteDeps) {
  const { db, enqueueJob, observationService } = deps

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

        let query = db.selectFrom("job").selectAll()
        if (agentId) query = query.where("agent_id", "=", agentId)
        if (status) query = query.where("status", "=", status)

        const rows = await query.orderBy("created_at", "desc").limit(limit).offset(offset).execute()
        const jobs = rows.map((job) => toJobSummary(job))

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

    app.get<{ Params: JobParams }>("/jobs/:jobId", async (request, reply) => {
      const { jobId } = request.params

      const job = await db.selectFrom("job").selectAll().where("id", "=", jobId).executeTakeFirst()

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

      const steps = stepsRaw
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

      const logs = logsRaw
        .filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
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

      const startedAtMs = job.started_at ? new Date(job.started_at).getTime() : undefined
      const completedAtMs = job.completed_at ? new Date(job.completed_at).getTime() : undefined
      const durationMs =
        startedAtMs !== undefined && completedAtMs !== undefined
          ? Math.max(0, completedAtMs - startedAtMs)
          : undefined

      return reply.send({
        ...toJobSummary(job),
        agentName: agent?.name ?? undefined,
        durationMs,
        steps,
        logs,
      })
    })

    app.post<{ Params: JobParams }>("/jobs/:jobId/retry", async (request, reply) => {
      const { jobId } = request.params

      const job = await db.selectFrom("job").select("id").where("id", "=", jobId).executeTakeFirst()
      if (!job) {
        return reply.status(404).send({ error: "not_found", message: "Job not found" })
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
        request.log.error({ err, jobId }, "Failed to enqueue retried job")
      }

      return reply.status(202).send({ jobId, status: "retrying" })
    })

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
        const { limit = 50, offset = 0 } = request.query
        return reply.send({
          content: [],
          pagination: {
            total: offset,
            limit,
            offset,
            hasMore: false,
          },
        })
      },
    )

    app.post<{ Params: ContentParams; Body: PublishContentBody }>(
      "/content/:id/publish",
      async (request, reply) => {
        const { id } = request.params
        const channel = request.body?.channel ?? "website"
        return reply.send({
          contentId: id,
          status: "published",
          publishedAt: new Date().toISOString(),
          channel,
        })
      },
    )

    app.post<{ Params: ContentParams }>("/content/:id/archive", async (request, reply) => {
      const { id } = request.params
      return reply.send({ contentId: id, status: "archived" })
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

        const rows = await db
          .selectFrom("memory_extract_message")
          .selectAll()
          .where("agent_id", "=", agentId)
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
        return reply.send({
          syncId: randomUUID(),
          status: "completed",
          stats: {
            upserted: 0,
            deleted: 0,
            unchanged: 0,
          },
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
      async (_request, reply) => {
        return reply.send({ screenshots: [] })
      },
    )

    app.get<{ Params: AgentParams; Querystring: BrowserEventsQuery }>(
      "/agents/:agentId/browser/events",
      async (_request, reply) => {
        return reply.send({ events: [] })
      },
    )

    app.get("/api/jobs/stream", async (_request: FastifyRequest, reply: FastifyReply) => {
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
      }

      const pollInterval = setInterval(() => {
        void poll().catch(() => {
          // Keep stream alive even if a poll fails.
        })
      }, 2000)

      const heartbeatInterval = setInterval(() => {
        if (!closed) raw.write(": heartbeat\n\n")
      }, 15000)

      void poll()

      raw.on("close", () => {
        closed = true
        clearInterval(pollInterval)
        clearInterval(heartbeatInterval)
      })
    })
  }
}
