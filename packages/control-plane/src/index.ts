import { initTracing, shutdownTracing } from "@cortex/shared/tracing"

import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { runMigrations } from "./db/auto-migrate.js"
import { createDatabase } from "./db/index.js"

const config = loadConfig()

// Initialize tracing before anything else
initTracing({
  enabled: config.tracing.enabled,
  serviceName: config.tracing.serviceName,
  endpoint: config.tracing.endpoint,
  sampleRate: config.tracing.sampleRate,
  exporterType: config.tracing.exporterType,
})

const { db, pool } = createDatabase(config.databaseUrl)

// Run pending migrations before starting the app
await runMigrations(pool)

const { app } = await buildApp({ db, pool, config })

// Shutdown tracing on app close
app.addHook("onClose", async () => {
  await shutdownTracing()
})

try {
  const address = await app.listen({ port: config.port, host: config.host })
  app.log.info(`Control plane listening on ${address}`)
} catch (err) {
  app.log.fatal(err)
  await shutdownTracing()
  process.exit(1)
}
