import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { attachPoolErrorHandler, endPoolGracefully } from "./postgres-teardown.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

let embeddedPg: EmbeddedPostgres
let pool: pg.Pool
let detachPoolErrorHandler: (() => void) | undefined

beforeAll(async () => {
  embeddedPg = new EmbeddedPostgres({
    databaseDir: join(__dirname, "../../.test-pgdata"),
    user: "cortex",
    password: "cortex_test",
    port: 15432,
    persistent: false,
  })
  await embeddedPg.initialise()
  await embeddedPg.start()
  await embeddedPg.createDatabase("cortex_test")

  pool = new pg.Pool({
    connectionString: "postgres://cortex:cortex_test@localhost:15432/cortex_test",
  })
  detachPoolErrorHandler = attachPoolErrorHandler(pool)
}, 60_000)

afterAll(async () => {
  if (pool) await endPoolGracefully(pool)
  if (embeddedPg) await embeddedPg.stop()
  detachPoolErrorHandler?.()
}, 30_000)

async function runMigrations(client: pg.PoolClient, direction: "up" | "down"): Promise<void> {
  const files = await readdir(MIGRATIONS_DIR)
  const migrations = files
    .filter((f) => f.endsWith(`.${direction}.sql`))
    .sort(direction === "up" ? undefined : (a, b) => b.localeCompare(a))

  for (const file of migrations) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8")
    await client.query(sql)
  }
}

async function tableExists(client: pg.PoolClient, tableName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    )`,
    [tableName],
  )
  return result.rows[0]?.exists ?? false
}

async function enumExists(client: pg.PoolClient, enumName: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = $1)`,
    [enumName],
  )
  return result.rows[0]?.exists ?? false
}

describe("PostgreSQL migrations", () => {
  it("applies all up migrations and creates expected schema objects", async () => {
    const client = await pool.connect()
    try {
      await runMigrations(client, "up")

      // Verify enums exist
      expect(await enumExists(client, "job_status")).toBe(true)
      expect(await enumExists(client, "agent_status")).toBe(true)
      expect(await enumExists(client, "approval_status")).toBe(true)
      expect(await enumExists(client, "tool_approval_policy")).toBe(true)
      expect(await enumExists(client, "agent_auth_model")).toBe(true)

      // Verify tables exist
      expect(await tableExists(client, "agent")).toBe(true)
      expect(await tableExists(client, "user_account")).toBe(true)
      expect(await tableExists(client, "channel_mapping")).toBe(true)
      expect(await tableExists(client, "session")).toBe(true)
      expect(await tableExists(client, "memory_extract_session_state")).toBe(true)
      expect(await tableExists(client, "memory_extract_message")).toBe(true)
      expect(await tableExists(client, "job")).toBe(true)
      expect(await tableExists(client, "approval_request")).toBe(true)
      expect(await tableExists(client, "agent_tool_binding")).toBe(true)
      expect(await tableExists(client, "capability_audit_log")).toBe(true)
      expect(await tableExists(client, "tool_category")).toBe(true)
      expect(await tableExists(client, "tool_category_membership")).toBe(true)

      // Verify job_status enum values
      const enumResult = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
         WHERE pg_type.typname = 'job_status'
         ORDER BY enumsortorder`,
      )
      expect(enumResult.rows.map((r) => r.enumlabel)).toEqual([
        "PENDING",
        "SCHEDULED",
        "RUNNING",
        "WAITING_FOR_APPROVAL",
        "COMPLETED",
        "FAILED",
        "TIMED_OUT",
        "RETRYING",
        "DEAD_LETTER",
      ])
    } finally {
      client.release()
    }
  })

  it("enforces valid job state transitions via trigger", async () => {
    const client = await pool.connect()
    try {
      // Insert an agent (required FK)
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('test-agent', 'test-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      // Insert a job in PENDING state
      const jobResult = await client.query<{ id: string }>(
        `INSERT INTO job (agent_id, payload) VALUES ($1, '{"task": "test"}')
         RETURNING id`,
        [agentId],
      )
      const jobId = jobResult.rows[0]!.id

      // Valid: PENDING → SCHEDULED
      await expect(
        client.query("UPDATE job SET status = 'SCHEDULED' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Valid: SCHEDULED → RUNNING
      await expect(
        client.query("UPDATE job SET status = 'RUNNING' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Invalid: RUNNING → PENDING (not a valid transition)
      await expect(
        client.query("UPDATE job SET status = 'PENDING' WHERE id = $1", [jobId]),
      ).rejects.toThrow(/Invalid job transition/)

      // Invalid: RUNNING → DEAD_LETTER (not a valid transition from RUNNING)
      await expect(
        client.query("UPDATE job SET status = 'DEAD_LETTER' WHERE id = $1", [jobId]),
      ).rejects.toThrow(/Invalid job transition/)

      // Valid: RUNNING → WAITING_FOR_APPROVAL
      await expect(
        client.query("UPDATE job SET status = 'WAITING_FOR_APPROVAL' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Valid: WAITING_FOR_APPROVAL → RUNNING
      await expect(
        client.query("UPDATE job SET status = 'RUNNING' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Valid: RUNNING → FAILED
      await expect(
        client.query("UPDATE job SET status = 'FAILED' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Valid: FAILED → RETRYING
      await expect(
        client.query("UPDATE job SET status = 'RETRYING' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Valid: RETRYING → SCHEDULED
      await expect(
        client.query("UPDATE job SET status = 'SCHEDULED' WHERE id = $1", [jobId]),
      ).resolves.toBeTruthy()

      // Move to terminal: SCHEDULED → RUNNING → COMPLETED
      await client.query("UPDATE job SET status = 'RUNNING' WHERE id = $1", [jobId])
      await client.query("UPDATE job SET status = 'COMPLETED' WHERE id = $1", [jobId])

      // Terminal state: COMPLETED cannot transition
      await expect(
        client.query("UPDATE job SET status = 'RUNNING' WHERE id = $1", [jobId]),
      ).rejects.toThrow(/Invalid job transition/)

      // Clean up
      await client.query("DELETE FROM job WHERE id = $1", [jobId])
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])
    } finally {
      client.release()
    }
  })

  it("auto-updates updated_at via trigger", async () => {
    const client = await pool.connect()
    try {
      const result = await client.query<{ id: string; updated_at: Date }>(
        `INSERT INTO agent (name, slug, role) VALUES ('ts-agent', 'ts-agent', 'test')
         RETURNING id, updated_at`,
      )
      const agentId = result.rows[0]!.id
      const originalUpdatedAt = result.rows[0]!.updated_at

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 50))

      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE agent SET description = 'updated' WHERE id = $1 RETURNING updated_at`,
        [agentId],
      )

      expect(updated.rows[0]!.updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime())

      // Clean up
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])
    } finally {
      client.release()
    }
  })

  it("enforces channel_mapping uniqueness and lowercase constraint", async () => {
    const client = await pool.connect()
    try {
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO user_account (display_name) VALUES ('Test User') RETURNING id`,
      )
      const userId = userResult.rows[0]!.id

      await client.query(
        `INSERT INTO channel_mapping (user_account_id, channel_type, channel_user_id)
         VALUES ($1, 'telegram', '12345')`,
        [userId],
      )

      // Duplicate should fail
      await expect(
        client.query(
          `INSERT INTO channel_mapping (user_account_id, channel_type, channel_user_id)
           VALUES ($1, 'telegram', '12345')`,
          [userId],
        ),
      ).rejects.toThrow()

      // Uppercase channel_type should fail CHECK constraint
      await expect(
        client.query(
          `INSERT INTO channel_mapping (user_account_id, channel_type, channel_user_id)
           VALUES ($1, 'TELEGRAM', '99999')`,
          [userId],
        ),
      ).rejects.toThrow()

      // Clean up
      await client.query("DELETE FROM user_account WHERE id = $1", [userId])
    } finally {
      client.release()
    }
  })

  it("migration 018: creates agent_tool_binding, capability_audit_log, tool_category tables and enum", async () => {
    const client = await pool.connect()
    try {
      // Tables
      expect(await tableExists(client, "agent_tool_binding")).toBe(true)
      expect(await tableExists(client, "capability_audit_log")).toBe(true)
      expect(await tableExists(client, "tool_category")).toBe(true)
      expect(await tableExists(client, "tool_category_membership")).toBe(true)

      // Enum
      expect(await enumExists(client, "tool_approval_policy")).toBe(true)
      const enumResult = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
         WHERE pg_type.typname = 'tool_approval_policy'
         ORDER BY enumsortorder`,
      )
      expect(enumResult.rows.map((r) => r.enumlabel)).toEqual([
        "auto",
        "always_approve",
        "conditional",
      ])

      // effective_capabilities column removed in migration 034

      // Deprecation comment on mcp_server.agent_scope
      const commentResult = await client.query<{ description: string | null }>(
        `SELECT col_description(c.oid, a.attnum) AS description
         FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE c.relname = 'mcp_server' AND a.attname = 'agent_scope'`,
      )
      expect(commentResult.rows[0]?.description).toContain("DEPRECATED")
    } finally {
      client.release()
    }
  })

  it("migration 018: enforces UNIQUE(agent_id, tool_ref) on agent_tool_binding", async () => {
    const client = await pool.connect()
    try {
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('uniq-agent', 'uniq-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      await client.query(
        `INSERT INTO agent_tool_binding (agent_id, tool_ref) VALUES ($1, 'tool_a')`,
        [agentId],
      )

      // Duplicate (agent_id, tool_ref) should fail
      await expect(
        client.query(`INSERT INTO agent_tool_binding (agent_id, tool_ref) VALUES ($1, 'tool_a')`, [
          agentId,
        ]),
      ).rejects.toThrow(/unique|duplicate/i)

      // Same tool_ref with different agent_id should succeed
      const agent2Result = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('uniq-agent-2', 'uniq-agent-2', 'test')
         RETURNING id`,
      )
      const agent2Id = agent2Result.rows[0]!.id

      await expect(
        client.query(`INSERT INTO agent_tool_binding (agent_id, tool_ref) VALUES ($1, 'tool_a')`, [
          agent2Id,
        ]),
      ).resolves.toBeTruthy()

      // Clean up
      await client.query("DELETE FROM agent WHERE id IN ($1, $2)", [agentId, agent2Id])
    } finally {
      client.release()
    }
  })

  it("migration 018: CASCADE delete removes bindings when agent is deleted", async () => {
    const client = await pool.connect()
    try {
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('cascade-agent', 'cascade-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      await client.query(
        `INSERT INTO agent_tool_binding (agent_id, tool_ref) VALUES ($1, 'tool_x'), ($1, 'tool_y')`,
        [agentId],
      )

      // Verify bindings exist
      const before = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding WHERE agent_id = $1`,
        [agentId],
      )
      expect(before.rows[0]!.cnt).toBe("2")

      // Delete the agent
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])

      // Bindings should be gone
      const after = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding WHERE agent_id = $1`,
        [agentId],
      )
      expect(after.rows[0]!.cnt).toBe("0")
    } finally {
      client.release()
    }
  })

  it("migration 018: auto-updates updated_at on agent_tool_binding", async () => {
    const client = await pool.connect()
    try {
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('trigger-agent', 'trigger-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      const insertResult = await client.query<{ id: string; updated_at: Date }>(
        `INSERT INTO agent_tool_binding (agent_id, tool_ref) VALUES ($1, 'tool_z')
         RETURNING id, updated_at`,
        [agentId],
      )
      const bindingId = insertResult.rows[0]!.id
      const originalUpdatedAt = insertResult.rows[0]!.updated_at

      await new Promise((resolve) => setTimeout(resolve, 50))

      const updated = await client.query<{ updated_at: Date }>(
        `UPDATE agent_tool_binding SET approval_policy = 'always_approve' WHERE id = $1
         RETURNING updated_at`,
        [bindingId],
      )
      expect(updated.rows[0]!.updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime())

      // Clean up
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])
    } finally {
      client.release()
    }
  })

  it("migration 019: migrates agent_scope and allowedTools into agent_tool_binding", async () => {
    const client = await pool.connect()
    try {
      // ── Seed data ───────────────────────────────────────────────────
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role, skill_config)
         VALUES ('scope-agent', 'scope-agent', 'test', '{"allowedTools": ["web_search", "memory_query"]}')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      const agent2Result = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role, skill_config)
         VALUES ('scope-agent-2', 'scope-agent-2', 'test', '{"allowed_tools": ["code_exec"]}')
         RETURNING id`,
      )
      const agent2Id = agent2Result.rows[0]!.id

      // Agent with no allowedTools — should produce no skill_config bindings
      const agent3Result = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('no-tools-agent', 'no-tools-agent', 'test')
         RETURNING id`,
      )
      const agent3Id = agent3Result.rows[0]!.id

      const serverResult = await client.query<{ id: string }>(
        `INSERT INTO mcp_server (name, slug, transport, connection, agent_scope)
         VALUES ('Test Server', 'test-srv', 'stdio', '{"command":"echo"}', $1)
         RETURNING id`,
        [JSON.stringify([agentId, agent3Id])],
      )
      const serverId = serverResult.rows[0]!.id

      // Server with empty scope — should not produce bindings
      await client.query(
        `INSERT INTO mcp_server (name, slug, transport, connection, agent_scope)
         VALUES ('Empty Server', 'empty-srv', 'stdio', '{"command":"true"}', '[]')`,
      )

      await client.query(
        `INSERT INTO mcp_server_tool (mcp_server_id, name, qualified_name, input_schema)
         VALUES ($1, 'read_file', 'mcp:test-srv:read_file', '{"type":"object"}'),
                ($1, 'write_file', 'mcp:test-srv:write_file', '{"type":"object"}')`,
        [serverId],
      )

      // ── Run migration 019 UP ──────────────────────────────────────
      const upSql = await readFile(join(MIGRATIONS_DIR, "019_migrate_agent_scope.up.sql"), "utf-8")
      await client.query(upSql)

      // ── Verify agent_tool_binding rows from agent_scope ───────────
      const mcpBindings = await client.query<{ agent_id: string; tool_ref: string }>(
        `SELECT agent_id::text, tool_ref FROM agent_tool_binding
         WHERE tool_ref LIKE 'mcp:%'
         ORDER BY agent_id, tool_ref`,
      )
      // agentId gets 2 tools, agent3Id gets 2 tools = 4 rows
      expect(mcpBindings.rows).toHaveLength(4)
      expect(mcpBindings.rows).toEqual(
        expect.arrayContaining([
          { agent_id: agentId, tool_ref: "mcp:test-srv:read_file" },
          { agent_id: agentId, tool_ref: "mcp:test-srv:write_file" },
          { agent_id: agent3Id, tool_ref: "mcp:test-srv:read_file" },
          { agent_id: agent3Id, tool_ref: "mcp:test-srv:write_file" },
        ]),
      )

      // ── Verify agent_tool_binding rows from skill_config ──────────
      const skillBindings = await client.query<{ agent_id: string; tool_ref: string }>(
        `SELECT agent_id::text, tool_ref FROM agent_tool_binding
         WHERE tool_ref NOT LIKE 'mcp:%'
         ORDER BY agent_id, tool_ref`,
      )
      expect(skillBindings.rows).toEqual(
        expect.arrayContaining([
          { agent_id: agentId, tool_ref: "memory_query" },
          { agent_id: agentId, tool_ref: "web_search" },
          { agent_id: agent2Id, tool_ref: "code_exec" },
        ]),
      )
      expect(skillBindings.rows).toHaveLength(3)

      // ── Verify agent_scope is cleared ─────────────────────────────
      const scopeResult = await client.query<{ agent_scope: unknown[] }>(
        `SELECT agent_scope FROM mcp_server WHERE slug = 'test-srv'`,
      )
      expect(scopeResult.rows[0]!.agent_scope).toEqual([])

      // ── Verify all bindings have approval_policy = 'auto' ─────────
      const policyResult = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding WHERE approval_policy != 'auto'`,
      )
      expect(policyResult.rows[0]!.cnt).toBe("0")

      // ── Verify idempotency: re-running UP does not fail or duplicate
      await client.query(upSql)
      const afterRerun = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding`,
      )
      expect(afterRerun.rows[0]!.cnt).toBe("7") // same 4 MCP + 3 skill

      // ── Clean up seed data ────────────────────────────────────────
      await client.query("DELETE FROM agent_tool_binding")
      await client.query("DELETE FROM mcp_server_tool WHERE mcp_server_id = $1", [serverId])
      await client.query("DELETE FROM mcp_server WHERE slug IN ('test-srv', 'empty-srv')")
      await client.query("DELETE FROM agent WHERE id IN ($1, $2, $3)", [
        agentId,
        agent2Id,
        agent3Id,
      ])
    } finally {
      client.release()
    }
  })

  it("migration 019 down: restores agent_scope from bindings", async () => {
    const client = await pool.connect()
    try {
      // ── Seed data ───────────────────────────────────────────────────
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role, skill_config)
         VALUES ('down-agent', 'down-agent', 'test', '{"allowedTools": ["web_search"]}')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      const serverResult = await client.query<{ id: string }>(
        `INSERT INTO mcp_server (name, slug, transport, connection, agent_scope)
         VALUES ('Down Server', 'down-srv', 'stdio', '{"command":"echo"}', $1)
         RETURNING id`,
        [JSON.stringify([agentId])],
      )
      const serverId = serverResult.rows[0]!.id

      await client.query(
        `INSERT INTO mcp_server_tool (mcp_server_id, name, qualified_name, input_schema)
         VALUES ($1, 'ping', 'mcp:down-srv:ping', '{"type":"object"}')`,
        [serverId],
      )

      // Run UP migration
      const upSql = await readFile(join(MIGRATIONS_DIR, "019_migrate_agent_scope.up.sql"), "utf-8")
      await client.query(upSql)

      // Verify scope cleared and bindings exist
      const scopeBefore = await client.query<{ agent_scope: unknown[] }>(
        `SELECT agent_scope FROM mcp_server WHERE slug = 'down-srv'`,
      )
      expect(scopeBefore.rows[0]!.agent_scope).toEqual([])

      const bindingsBefore = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding WHERE agent_id = $1`,
        [agentId],
      )
      expect(bindingsBefore.rows[0]!.cnt).toBe("2") // 1 MCP + 1 skill

      // ── Run DOWN migration ────────────────────────────────────────
      const downSql = await readFile(
        join(MIGRATIONS_DIR, "019_migrate_agent_scope.down.sql"),
        "utf-8",
      )
      await client.query(downSql)

      // Verify agent_scope restored
      const scopeAfter = await client.query<{ agent_scope: string[] }>(
        `SELECT agent_scope FROM mcp_server WHERE slug = 'down-srv'`,
      )
      expect(scopeAfter.rows[0]!.agent_scope).toContain(agentId)

      // Verify migrated bindings removed
      const bindingsAfter = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM agent_tool_binding WHERE agent_id = $1`,
        [agentId],
      )
      expect(bindingsAfter.rows[0]!.cnt).toBe("0")

      // ── Clean up ──────────────────────────────────────────────────
      await client.query("DELETE FROM mcp_server_tool WHERE mcp_server_id = $1", [serverId])
      await client.query("DELETE FROM mcp_server WHERE slug = 'down-srv'")
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])
    } finally {
      client.release()
    }
  })

  it("migration 026: creates agent_auth_model enum with correct values", async () => {
    const client = await pool.connect()
    try {
      const enumResult = await client.query<{ enumlabel: string }>(
        `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
         WHERE pg_type.typname = 'agent_auth_model'
         ORDER BY enumsortorder`,
      )
      expect(enumResult.rows.map((r) => r.enumlabel)).toEqual([
        "allowlist",
        "approval_queue",
        "team",
        "open",
      ])
    } finally {
      client.release()
    }
  })

  it("migration 026: agent.auth_model defaults to 'allowlist'", async () => {
    const client = await pool.connect()
    try {
      const agentResult = await client.query<{ id: string; auth_model: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('auth-model-agent', 'auth-model-agent', 'test')
         RETURNING id, auth_model`,
      )
      expect(agentResult.rows[0]!.auth_model).toBe("allowlist")

      // Verify explicit values work
      await client.query(`UPDATE agent SET auth_model = 'approval_queue' WHERE id = $1`, [
        agentResult.rows[0]!.id,
      ])
      const updated = await client.query<{ auth_model: string }>(
        `SELECT auth_model FROM agent WHERE id = $1`,
        [agentResult.rows[0]!.id],
      )
      expect(updated.rows[0]!.auth_model).toBe("approval_queue")

      // Clean up
      await client.query("DELETE FROM agent WHERE id = $1", [agentResult.rows[0]!.id])
    } finally {
      client.release()
    }
  })

  it("migration 026: creates user_usage_ledger with constraints", async () => {
    const client = await pool.connect()
    try {
      expect(await tableExists(client, "user_usage_ledger")).toBe(true)

      // Seed data
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('ledger-agent', 'ledger-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO user_account (display_name) VALUES ('Ledger User') RETURNING id`,
      )
      const userId = userResult.rows[0]!.id

      // Insert a valid ledger row
      await client.query(
        `INSERT INTO user_usage_ledger (user_account_id, agent_id, period_start, period_end, messages_sent, tokens_in, tokens_out, cost_usd)
         VALUES ($1, $2, '2026-03-01', '2026-03-02', 10, 500, 200, 0.05)`,
        [userId, agentId],
      )

      // Duplicate (user, agent, period_start) should fail
      await expect(
        client.query(
          `INSERT INTO user_usage_ledger (user_account_id, agent_id, period_start, period_end)
           VALUES ($1, $2, '2026-03-01', '2026-03-02')`,
          [userId, agentId],
        ),
      ).rejects.toThrow(/unique|duplicate/i)

      // period_end <= period_start should fail CHECK constraint
      await expect(
        client.query(
          `INSERT INTO user_usage_ledger (user_account_id, agent_id, period_start, period_end)
           VALUES ($1, $2, '2026-03-05', '2026-03-05')`,
          [userId, agentId],
        ),
      ).rejects.toThrow()

      // Clean up (CASCADE should remove ledger rows)
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])
      await client.query("DELETE FROM user_account WHERE id = $1", [userId])
    } finally {
      client.release()
    }
  })

  it("migration 026: CASCADE deletes user_usage_ledger when agent or user is deleted", async () => {
    const client = await pool.connect()
    try {
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('cascade-ledger-agent', 'cascade-ledger-agent', 'test')
         RETURNING id`,
      )
      const agentId = agentResult.rows[0]!.id

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO user_account (display_name) VALUES ('Cascade User') RETURNING id`,
      )
      const userId = userResult.rows[0]!.id

      await client.query(
        `INSERT INTO user_usage_ledger (user_account_id, agent_id, period_start, period_end, messages_sent)
         VALUES ($1, $2, '2026-03-01', '2026-03-02', 5)`,
        [userId, agentId],
      )

      // Delete agent — ledger row should be removed
      await client.query("DELETE FROM agent WHERE id = $1", [agentId])

      const afterAgentDelete = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM user_usage_ledger WHERE agent_id = $1`,
        [agentId],
      )
      expect(afterAgentDelete.rows[0]!.cnt).toBe("0")

      // Re-insert for user cascade test
      const agent2Result = await client.query<{ id: string }>(
        `INSERT INTO agent (name, slug, role) VALUES ('cascade-ledger-agent-2', 'cascade-ledger-agent-2', 'test')
         RETURNING id`,
      )
      const agent2Id = agent2Result.rows[0]!.id

      await client.query(
        `INSERT INTO user_usage_ledger (user_account_id, agent_id, period_start, period_end, messages_sent)
         VALUES ($1, $2, '2026-03-01', '2026-03-02', 3)`,
        [userId, agent2Id],
      )

      // Delete user — ledger row should be removed
      await client.query("DELETE FROM user_account WHERE id = $1", [userId])

      const afterUserDelete = await client.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM user_usage_ledger WHERE user_account_id = $1`,
        [userId],
      )
      expect(afterUserDelete.rows[0]!.cnt).toBe("0")

      // Clean up
      await client.query("DELETE FROM agent WHERE id = $1", [agent2Id])
    } finally {
      client.release()
    }
  })

  it("migration 034: drops effective_capabilities column from agent", async () => {
    const client = await pool.connect()
    try {
      const colResult = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'agent'
            AND column_name = 'effective_capabilities'
        )`,
      )
      expect(colResult.rows[0]?.exists).toBe(false)
    } finally {
      client.release()
    }
  })

  it("rolls back all down migrations cleanly", async () => {
    const client = await pool.connect()
    try {
      await runMigrations(client, "down")

      expect(await tableExists(client, "approval_request")).toBe(false)
      expect(await tableExists(client, "job")).toBe(false)
      expect(await tableExists(client, "memory_extract_message")).toBe(false)
      expect(await tableExists(client, "memory_extract_session_state")).toBe(false)
      expect(await tableExists(client, "session")).toBe(false)
      expect(await tableExists(client, "channel_mapping")).toBe(false)
      expect(await tableExists(client, "user_account")).toBe(false)
      expect(await tableExists(client, "agent")).toBe(false)
      expect(await tableExists(client, "agent_tool_binding")).toBe(false)
      expect(await tableExists(client, "capability_audit_log")).toBe(false)
      expect(await tableExists(client, "tool_category")).toBe(false)
      expect(await tableExists(client, "tool_category_membership")).toBe(false)

      expect(await enumExists(client, "job_status")).toBe(false)
      expect(await enumExists(client, "agent_status")).toBe(false)
      expect(await enumExists(client, "approval_status")).toBe(false)
      expect(await enumExists(client, "tool_approval_policy")).toBe(false)
      expect(await enumExists(client, "agent_auth_model")).toBe(false)

      expect(await tableExists(client, "user_usage_ledger")).toBe(false)
    } finally {
      client.release()
    }
  })
})
