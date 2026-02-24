import Fastify, { type FastifyInstance } from "fastify"
import type { Kysely } from "kysely"
import type pg from "pg"

import { ApprovalService } from "./approval/service.js"
import type { Config } from "./config.js"
import type { Database } from "./db/types.js"
import type { AgentLifecycleManager } from "./lifecycle/manager.js"
import { approvalRoutes } from "./routes/approval.js"
import { healthRoutes } from "./routes/health.js"
import { streamRoutes } from "./routes/stream.js"
import { SSEConnectionManager } from "./streaming/manager.js"
import { createWorker, type Runner } from "./worker/index.js"
import { registerShutdownHandlers } from "./worker/shutdown.js"

export interface AppContext {
  app: FastifyInstance
  runner: Runner
  sseManager: SSEConnectionManager
}

export interface AppOptions {
  db: Kysely<Database>
  pool: pg.Pool
  config: Config
  lifecycleManager?: AgentLifecycleManager
}

export async function buildApp(options: AppOptions): Promise<AppContext> {
  const { db, pool, config } = options
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  })

  // Start Graphile Worker alongside Fastify — shared pg.Pool
  const runner = await createWorker({
    pgPool: pool,
    db,
    concurrency: config.workerConcurrency,
  })

  // SSE connection manager for agent streaming
  const sseManager = new SSEConnectionManager()

  // Decorate Fastify with runner + db references for health checks
  app.decorate("worker", runner)
  app.decorate("db", db)

  // Approval service — core approval gate logic
  const approvalService = new ApprovalService({ db })

  await app.register(healthRoutes)

  // Register approval routes (always available)
  await app.register(
    approvalRoutes({ approvalService, sseManager }),
  )

  // Register streaming routes if lifecycle manager is provided
  if (options.lifecycleManager) {
    await app.register(
      streamRoutes({ sseManager, lifecycleManager: options.lifecycleManager }),
    )
  }

  // Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers({ fastify: app, runner, pool })

  // Shut down SSE connections on app close
  app.addHook("onClose", async () => {
    sseManager.shutdown()
  })

  return { app, runner, sseManager }
}
