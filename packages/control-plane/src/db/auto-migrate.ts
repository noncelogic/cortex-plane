/**
 * Auto-migration — runs pending migrations on startup.
 *
 * Uses the same logic as migrate.ts but exported as a callable function
 * (rather than a CLI script) for use in index.ts.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type pg from "pg"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

interface MigrationFile {
  version: number
  name: string
  filename: string
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const applied = await client.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
    const appliedSet = new Set(applied.rows.map((r) => r.version))

    const files = await readdir(MIGRATIONS_DIR)
    const upMigrations: MigrationFile[] = []

    for (const file of files) {
      const match = /^(\d+)_(.+)\.up\.sql$/.exec(file)
      if (!match) continue
      const version = parseInt(match[1]!, 10)
      if (appliedSet.has(version)) continue
      upMigrations.push({ version, name: match[2]!, filename: file })
    }

    upMigrations.sort((a, b) => a.version - b.version)

    if (upMigrations.length === 0) {
      console.log("[auto-migrate] No pending migrations.")
      return
    }

    for (const migration of upMigrations) {
      const sql = await readFile(join(MIGRATIONS_DIR, migration.filename), "utf-8")
      console.log(`[auto-migrate] Applying ${migration.version}_${migration.name}...`)

      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.name,
        ])
        await client.query("COMMIT")
        console.log(`[auto-migrate]   ✓ Applied ${migration.version}_${migration.name}`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
    }

    console.log(`[auto-migrate] Applied ${String(upMigrations.length)} migration(s).`)
  } finally {
    client.release()
  }
}
