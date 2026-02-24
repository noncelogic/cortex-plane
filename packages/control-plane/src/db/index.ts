import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"

import type { Database } from "./types.js"

export function createDatabase(connectionString?: string): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString:
      connectionString ?? process.env.DATABASE_URL ?? "postgres://cortex:cortex_dev@localhost:5432/cortex_plane",
  })

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

export type { Database } from "./types.js"
