import { initTracing, shutdownTracing } from "@cortex/shared/tracing"

import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { createDatabase } from "./db/index.js"

const config = loadConfig()

// Initialize OpenTelemetry before any instrumented code runs
initTracing(config.tracing)

const { db, pool } = createDatabase(config.databaseUrl)
const { app } = await buildApp({ db, pool, config })

// Flush spans on shutdown
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
