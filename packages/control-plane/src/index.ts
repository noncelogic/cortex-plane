import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { createDatabase } from "./db/index.js"

const config = loadConfig()
const { db, pool } = createDatabase(config.databaseUrl)
const { app } = await buildApp({ db, pool, config })

try {
  const address = await app.listen({ port: config.port, host: config.host })
  app.log.info(`Control plane listening on ${address}`)
} catch (err) {
  app.log.fatal(err)
  process.exit(1)
}
