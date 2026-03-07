/**
 * One-shot script — Migrate mcp_server.agent_scope and
 * agent.skill_config.allowedTools into agent_tool_binding rows.
 *
 * Usage: npx tsx scripts/migrate-agent-scope.ts
 *
 * Reads DATABASE_URL from env (falls back to local dev default).
 * Idempotent: safe to run multiple times.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import pg from "pg"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cortex:cortex_dev@localhost:5432/cortex_plane"

async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    const sql = await readFile(
      join(__dirname, "../migrations/019_migrate_agent_scope.up.sql"),
      "utf-8",
    )
    await client.query(sql)

    // Report what was created
    const bindingCount = await client.query<{ cnt: string }>(
      "SELECT count(*)::text AS cnt FROM agent_tool_binding",
    )
    const clearedServers = await client.query<{ cnt: string }>(
      "SELECT count(*)::text AS cnt FROM mcp_server WHERE agent_scope = '[]'::jsonb",
    )

    await client.query("COMMIT")

    console.log(`Migration complete:`)
    console.log(`  Total agent_tool_binding rows: ${bindingCount.rows[0]!.cnt}`)
    console.log(`  MCP servers with cleared agent_scope: ${clearedServers.rows[0]!.cnt}`)
  } catch (err) {
    await client.query("ROLLBACK")
    console.error("Migration failed, rolled back:", err)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

await migrate()
