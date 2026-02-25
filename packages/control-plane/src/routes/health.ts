import type { FastifyInstance } from "fastify"
import type { Kysely } from "kysely"
import type { Runner } from "graphile-worker"

import type { BackendRegistry } from "@cortex/shared/backends"
import type { Database } from "../db/types.js"

declare module "fastify" {
  interface FastifyInstance {
    worker: Runner
    db: Kysely<Database>
    backendRegistry?: BackendRegistry
  }
}

export function healthRoutes(app: FastifyInstance): void {
  /** Liveness — always 200 if process is up. */
  app.get("/healthz", async (_request, reply) => {
    return reply.send({ status: "ok" })
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
}
