import Fastify, { type FastifyInstance } from "fastify"
import type { Kysely } from "kysely"
import type pg from "pg"

import type { Database } from "./db/types.js"
import { healthRoutes } from "./routes/health.js"
import { createWorker, type Runner } from "./worker/index.js"
import { registerShutdownHandlers } from "./worker/shutdown.js"

export interface AppContext {
  app: FastifyInstance
  runner: Runner
}

export interface AppOptions {
  db: Kysely<Database>
  pool: pg.Pool
}

export async function buildApp(options: AppOptions): Promise<AppContext> {
  const { db, pool } = options
  const app = Fastify({ logger: true })

  // Start Graphile Worker alongside Fastify — shared pg.Pool
  const runner = await createWorker({ pgPool: pool, db })

  // Decorate Fastify with runner reference for health checks
  app.decorate("worker", runner)

  await app.register(healthRoutes)

  // Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers({ fastify: app, runner, pool })

  return { app, runner }
}
