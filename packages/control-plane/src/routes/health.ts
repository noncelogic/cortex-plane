import type { BackendRegistry } from "@cortex/shared/backends"
import type { ChannelSupervisor } from "@cortex/shared/channels"
import type { FastifyInstance } from "fastify"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

declare module "fastify" {
  interface FastifyInstance {
    worker: Runner
    db: Kysely<Database>
    backendRegistry?: BackendRegistry
    channelSupervisor?: ChannelSupervisor
    sseManager?: SSEConnectionManager
  }
}

export function healthRoutes(app: FastifyInstance): void {
  /** Liveness — always 200 if process is up. */
  app.get("/healthz", async (_request, reply) => {
    const supervisor = app.channelSupervisor
    if (!supervisor) {
      return reply.send({ status: "ok" })
    }

    const adapters = supervisor.getAllStatuses()
    const overallHealthy = adapters.every((adapter) => adapter.healthy)
    return reply.send({
      status: overallHealthy ? "ok" : "degraded",
      channels: {
        status: overallHealthy ? "ok" : "degraded",
        adapters,
      },
    })
  })

  /**
   * Readiness — checks that critical subsystems are operational:
   * - Graphile Worker runner is present
   * - PostgreSQL is reachable (SELECT 1)
   */
  app.get("/readyz", async (_request, reply) => {
    const checks: Record<string, boolean> = {
      worker: app.worker !== undefined,
      db: false,
    }

    try {
      await app.db.selectFrom("agent").select("id").limit(0).execute()
      checks.db = true
    } catch {
      // DB unreachable
    }

    const ready = Object.values(checks).every(Boolean)
    const status = ready ? "ok" : "not_ready"
    const code = ready ? 200 : 503

    return reply.status(code).send({ status, checks })
  })

  /**
   * Backend health — exposes circuit breaker states and backend health
   * for each registered execution backend.
   */
  app.get("/health/backends", async (_request, reply) => {
    const registry = app.backendRegistry
    if (!registry) {
      return reply.status(503).send({
        status: "unavailable",
        reason: "Backend registry not configured",
      })
    }

    const backendIds = registry.list()
    const healthReports = await registry.getAllHealth()
    const circuitStats = registry.getCircuitStats()

    const backends = backendIds.map((id) => {
      const health = healthReports.find((r) => r.backendId === id)
      const stats = circuitStats.get(id)

      return {
        backendId: id,
        health: health
          ? {
              status: health.status,
              reason: health.reason,
              checkedAt: health.checkedAt,
              latencyMs: health.latencyMs,
            }
          : null,
        circuitBreaker: stats
          ? {
              state: stats.state,
              windowFailureCount: stats.windowFailureCount,
              windowTotalCalls: stats.windowTotalCalls,
              consecutiveHalfOpenSuccesses: stats.consecutiveHalfOpenSuccesses,
              lastStateChange: stats.lastStateChange,
            }
          : null,
      }
    })

    return reply.send({ status: "ok", backends })
  })

  app.get("/health/stream", async (_request, reply) => {
    const sseManager = app.sseManager
    if (!sseManager) {
      return reply.status(503).send({
        status: "unavailable",
        reason: "SSE manager not configured",
      })
    }

    const raw = reply.raw
    const conn = sseManager.connect("_channel_health", raw)
    _request.log.info(
      { connectionId: conn.connectionId },
      "Channel health SSE connection established",
    )
    reply.hijack()
  })
}
