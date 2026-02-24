import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import EmbeddedPostgres from "embedded-postgres"
import { makeWorkerUtils, run, type Runner, type WorkerUtils } from "graphile-worker"
import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { Database } from "../db/types.js"
import { createAgentExecuteTask } from "../worker/tasks/agent-execute.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")
const PG_DATA_DIR = join(__dirname, "../../.test-pgdata-worker")
const PG_PORT = 15433

let embeddedPg: EmbeddedPostgres
let pool: pg.Pool
let db: Kysely<Database>
let runner: Runner
let workerUtils: WorkerUtils

beforeAll(async () => {
  // Clean up stale data directory from previous failed runs
  await rm(PG_DATA_DIR, { recursive: true, force: true })

  embeddedPg = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR,
    user: "cortex",
    password: "cortex_test",
    port: PG_PORT,
    persistent: false,
  })
  await embeddedPg.initialise()
  await embeddedPg.start()
  await embeddedPg.createDatabase("cortex_worker_test")

  const connStr = `postgres://cortex:cortex_test@localhost:${PG_PORT}/cortex_worker_test`
  pool = new pg.Pool({ connectionString: connStr })

  // Run all migrations
  const client = await pool.connect()
  try {
    const files = await readdir(MIGRATIONS_DIR)
    const migrations = files.filter((f) => f.endsWith(".up.sql")).sort()
    for (const file of migrations) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8")
      await client.query(sql)
    }
  } finally {
    client.release()
  }

  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

  // Start Graphile Worker with our task handler
  runner = await run({
    pgPool: pool,
    taskList: {
      agent_execute: createAgentExecuteTask(db),
    },
    concurrency: 1,
    noHandleSignals: true,
  })

  workerUtils = await makeWorkerUtils({ pgPool: pool })
}, 60_000)

afterAll(async () => {
  if (workerUtils) await workerUtils.release()
  if (runner) await runner.stop()
  if (db) await db.destroy()
  if (embeddedPg) await embeddedPg.stop()
}, 30_000)

describe("Worker integration", () => {
  it("enqueues a job, worker picks it up, and transitions through states", async () => {
    // Insert an agent
    const agentResult = await db
      .insertInto("agent")
      .values({
        name: "integration-test-agent",
        slug: "integration-test-agent",
        role: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    // Insert a job in PENDING state
    const jobResult = await db
      .insertInto("job")
      .values({
        agent_id: agentResult.id,
        payload: { task: "integration-test" },
        max_attempts: 3,
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    const jobId = jobResult.id

    // Transition to SCHEDULED (the trigger validates PENDING → SCHEDULED)
    await db.updateTable("job").set({ status: "SCHEDULED" }).where("id", "=", jobId).execute()

    // Verify job is SCHEDULED
    const scheduledJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()
    expect(scheduledJob.status).toBe("SCHEDULED")

    // Enqueue to Graphile Worker
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    // Wait for the worker to process the job
    // The placeholder task immediately completes, so this should be fast
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        void db
          .selectFrom("job")
          .select("status")
          .where("id", "=", jobId)
          .executeTakeFirst()
          .then((job) => {
            if (job && (job.status === "COMPLETED" || job.status === "FAILED")) {
              clearInterval(check)
              resolve()
            }
          })
      }, 100)

      // Safety timeout
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 10_000)
    })

    // Verify the job reached COMPLETED
    const completedJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(completedJob.status).toBe("COMPLETED")
    expect(completedJob.started_at).not.toBeNull()
    expect(completedJob.completed_at).not.toBeNull()
    expect(completedJob.result).toEqual({
      placeholder: true,
      message: "Execution backend not yet implemented",
    })
    expect(completedJob.attempt).toBe(1)

    // Clean up
    await db.deleteFrom("job").where("id", "=", jobId).execute()
    await db.deleteFrom("agent").where("id", "=", agentResult.id).execute()
  }, 30_000)
})
