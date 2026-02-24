import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"

import type { Database } from "./types.js"

export interface DatabaseConnection {
  db: Kysely<Database>
  pool: pg.Pool
}

export function createDatabase(connectionString?: string): DatabaseConnection {
  const pool = new pg.Pool({
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      "postgres://cortex:cortex_dev@localhost:5432/cortex_plane",
  })

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })

  return { db, pool }
}

export type { Database } from "./types.js"
