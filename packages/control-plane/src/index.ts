import { buildApp } from "./app.js"
import { createDatabase } from "./db/index.js"

const { db, pool } = createDatabase()
const { app } = await buildApp({ db, pool })

try {
  const address = await app.listen({ port: 4000, host: "0.0.0.0" })
  app.log.info(`Control plane listening on ${address}`)
} catch (err) {
  app.log.fatal(err)
  process.exit(1)
}
