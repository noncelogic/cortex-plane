import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")

let embeddedPg: EmbeddedPostgres
let pool: pg.Pool

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
}, 60_000)

afterAll(async () => {
  await pool.end()
  await embeddedPg.stop()
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

      // Verify tables exist
      expect(await tableExists(client, "agent")).toBe(true)
      expect(await tableExists(client, "user_account")).toBe(true)
      expect(await tableExists(client, "channel_mapping")).toBe(true)
      expect(await tableExists(client, "session")).toBe(true)
      expect(await tableExists(client, "memory_extract_session_state")).toBe(true)
      expect(await tableExists(client, "memory_extract_message")).toBe(true)
      expect(await tableExists(client, "job")).toBe(true)
      expect(await tableExists(client, "approval_request")).toBe(true)

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

      expect(await enumExists(client, "job_status")).toBe(false)
      expect(await enumExists(client, "agent_status")).toBe(false)
      expect(await enumExists(client, "approval_status")).toBe(false)
    } finally {
      client.release()
    }
  })
})
