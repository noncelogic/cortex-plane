/**
 * Graceful shutdown handler for Graphile Worker + Fastify.
 *
 * Shutdown sequence (from spec §5.3 and spike #28):
 * T+0s   SIGTERM received
 * T+0s   Stop accepting new HTTP requests (fastify.close())
 * T+0s   Stop accepting new jobs (runner.stop())
 * T+45s  Deadline — if runner hasn't stopped, force-proceed
 * T+50s  Close database pool
 * T+55s  Process exits (well before k8s SIGKILL at T+65s)
 */

import type { FastifyInstance } from "fastify"
import type { Runner } from "graphile-worker"
import type { Pool } from "pg"

export interface ShutdownDeps {
  fastify: FastifyInstance
  runner: Runner
  pool: Pool
  onDrainStart?: () => Promise<void>
}

/** Maximum time to wait for active jobs to drain before forcing shutdown */
const WORKER_STOP_DEADLINE_MS = 45_000

/**
 * Register SIGTERM and SIGINT handlers that perform graceful shutdown.
 * Returns a cleanup function to remove the signal listeners.
 */
export function registerShutdownHandlers(deps: ShutdownDeps): () => void {
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    deps.fastify.log.info({ signal }, "Shutdown signal received, draining…")

    // 1. Stop accepting new HTTP requests
    await deps.fastify.close().catch((err: unknown) => {
      deps.fastify.log.error({ err }, "Error closing Fastify")
    })

    if (deps.onDrainStart) {
      await deps.onDrainStart().catch((err: unknown) => {
        deps.fastify.log.error({ err }, "Error during pre-drain hooks")
      })
    }

    // 2. Stop Graphile Worker with a deadline
    const workerStopped = deps.runner.stop()
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, WORKER_STOP_DEADLINE_MS))

    await Promise.race([workerStopped, deadline]).catch((err: unknown) => {
      deps.fastify.log.error({ err }, "Error stopping Graphile Worker")
    })

    // 3. Close the database pool
    await deps.pool.end().catch((err: unknown) => {
      deps.fastify.log.error({ err }, "Error closing database pool")
    })

    deps.fastify.log.info("Shutdown complete")
    process.exit(0)
  }

  const onSigterm = (): void => void shutdown("SIGTERM")
  const onSigint = (): void => void shutdown("SIGINT")

  process.on("SIGTERM", onSigterm)
  process.on("SIGINT", onSigint)

  // Catch unhandled errors so the process doesn't die silently
  const onUnhandledRejection = (err: unknown): void => {
    deps.fastify.log.fatal({ err }, "Unhandled promise rejection — shutting down")
    void shutdown("unhandledRejection")
  }
  const onUncaughtException = (err: unknown): void => {
    deps.fastify.log.fatal({ err }, "Uncaught exception — shutting down")
    void shutdown("uncaughtException")
  }

  process.on("unhandledRejection", onUnhandledRejection)
  process.on("uncaughtException", onUncaughtException)

  return () => {
    process.removeListener("SIGTERM", onSigterm)
    process.removeListener("SIGINT", onSigint)
    process.removeListener("unhandledRejection", onUnhandledRejection)
    process.removeListener("uncaughtException", onUncaughtException)
  }
}
