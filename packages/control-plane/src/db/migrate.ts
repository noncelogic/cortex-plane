import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cortex:cortex_dev@localhost:5432/cortex_plane"

interface MigrationRow {
  version: number
  name: string
  applied_at: Date
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

async function getAppliedVersions(client: pg.PoolClient): Promise<Set<number>> {
  const result = await client.query<MigrationRow>(
    "SELECT version FROM schema_migrations ORDER BY version",
  )
  return new Set(result.rows.map((r) => r.version))
}

interface MigrationFile {
  version: number
  name: string
  direction: "up" | "down"
  filename: string
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const files = await readdir(MIGRATIONS_DIR)
  const migrations: MigrationFile[] = []

  for (const file of files) {
    const match = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(file)
    if (!match) continue
    migrations.push({
      version: parseInt(match[1]!, 10),
      name: match[2]!,
      direction: match[3] as "up" | "down",
      filename: file,
    })
  }

  return migrations.sort((a, b) => a.version - b.version || a.direction.localeCompare(b.direction))
}

async function migrateUp(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedVersions(client)
    const migrations = await loadMigrations()

    const upMigrations = migrations
      .filter((m) => m.direction === "up" && !applied.has(m.version))
      .sort((a, b) => a.version - b.version)

    if (upMigrations.length === 0) {
      console.log("No pending migrations.")
      return
    }

    for (const migration of upMigrations) {
      const sql = await readFile(join(MIGRATIONS_DIR, migration.filename), "utf-8")
      console.log(`Applying migration ${migration.version}_${migration.name}...`)

      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.name,
        ])
        await client.query("COMMIT")
        console.log(`  ✓ Applied ${migration.version}_${migration.name}`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
    }

    console.log(`Applied ${String(upMigrations.length)} migration(s).`)
  } finally {
    client.release()
    await pool.end()
  }
}

async function migrateDown(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedVersions(client)
    const migrations = await loadMigrations()

    if (applied.size === 0) {
      console.log("No migrations to roll back.")
      return
    }

    const maxVersion = Math.max(...applied)
    const downMigration = migrations.find((m) => m.version === maxVersion && m.direction === "down")

    if (!downMigration) {
      console.error(`No down migration found for version ${String(maxVersion)}`)
      process.exit(1)
    }

    const sql = await readFile(join(MIGRATIONS_DIR, downMigration.filename), "utf-8")
    console.log(`Rolling back migration ${downMigration.version}_${downMigration.name}...`)

    await client.query("BEGIN")
    try {
      await client.query(sql)
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [
        downMigration.version,
      ])
      await client.query("COMMIT")
      console.log(`  ✓ Rolled back ${downMigration.version}_${downMigration.name}`)
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    }
  } finally {
    client.release()
    await pool.end()
  }
}

async function migrateDownAll(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await ensureMigrationsTable(client)
    const applied = await getAppliedVersions(client)
    const migrations = await loadMigrations()

    const downMigrations = migrations
      .filter((m) => m.direction === "down" && applied.has(m.version))
      .sort((a, b) => b.version - a.version)

    if (downMigrations.length === 0) {
      console.log("No migrations to roll back.")
      return
    }

    for (const migration of downMigrations) {
      const sql = await readFile(join(MIGRATIONS_DIR, migration.filename), "utf-8")
      console.log(`Rolling back migration ${migration.version}_${migration.name}...`)

      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("DELETE FROM schema_migrations WHERE version = $1", [migration.version])
        await client.query("COMMIT")
        console.log(`  ✓ Rolled back ${migration.version}_${migration.name}`)
      } catch (err) {
        await client.query("ROLLBACK")
        throw err
      }
    }

    console.log(`Rolled back ${String(downMigrations.length)} migration(s).`)
  } finally {
    client.release()
    await pool.end()
  }
}

const command = process.argv[2]

switch (command) {
  case "up":
  case undefined:
    await migrateUp()
    break
  case "down":
    await migrateDown()
    break
  case "down-all":
    await migrateDownAll()
    break
  default:
    console.error(`Unknown command: ${command}`)
    console.error("Usage: db:migrate [up|down|down-all]")
    process.exit(1)
}
