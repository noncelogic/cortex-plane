import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  BackendRegistry,
  type ExecutionBackend,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionTask,
  type OutputEvent,
} from "@cortex/shared/backends"
import type { MemoryStore, ScoredMemoryRecord } from "@cortex/shared/memory"
import EmbeddedPostgres from "embedded-postgres"
import { makeWorkerUtils, run, type Runner, type WorkerUtils } from "graphile-worker"
import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { createMemoryScheduler } from "../worker/memory-scheduler.js"
import { createAgentExecuteTask } from "../worker/tasks/agent-execute.js"
import {
  createMemoryExtractTask,
  type EmbeddingFn,
  type LLMCaller,
} from "../worker/tasks/memory-extract.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")
const PG_DATA_DIR = join(__dirname, "../../.test-pgdata-memory-scheduling")
const PG_PORT = 15434

let embeddedPg: EmbeddedPostgres
let pool: pg.Pool
let db: Kysely<Database>
let runner: Runner
let workerUtils: WorkerUtils

function mockStore(searchResults: ScoredMemoryRecord[] = []): MemoryStore {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(searchResults),
    getById: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

const mockEmbed: EmbeddingFn = () => Promise.resolve(Array.from({ length: 16 }, () => 0.01))

function createResult(status: ExecutionResult["status"] = "completed"): ExecutionResult {
  return {
    taskId: "task-1",
    status,
    exitCode: status === "completed" ? 0 : 1,
    summary: "done",
    fileChanges: [],
    stdout: "",
    stderr: "",
    tokenUsage: {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    artifacts: [],
    durationMs: 10,
  }
}

function createHandle(events: OutputEvent[], result: ExecutionResult): ExecutionHandle {
  return {
    taskId: "task-1",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      for (const event of events) {
        yield event
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async result() {
      return result
    },
    async cancel() {},
  }
}

async function createRegistry(handle: ExecutionHandle): Promise<BackendRegistry> {
  const backend: ExecutionBackend = {
    backendId: "test-backend",
    async start() {},
    async stop() {},
    // eslint-disable-next-line @typescript-eslint/require-await
    async healthCheck() {
      return {
        backendId: "test-backend",
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: 1,
        details: {},
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async executeTask(_task: ExecutionTask) {
      return handle
    },
    getCapabilities() {
      return {
        supportsStreaming: true,
        supportsFileEdit: true,
        supportsShellExecution: true,
        reportsTokenUsage: true,
        supportsCancellation: true,
        supportedGoalTypes: [
          "code_edit",
          "code_generate",
          "code_review",
          "shell_command",
          "research",
        ],
        maxContextTokens: 200_000,
      }
    },
  }

  const registry = new BackendRegistry()
  await registry.register(backend, {}, 2)
  return registry
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`)
}

beforeAll(async () => {
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
  await embeddedPg.createDatabase("cortex_memory_scheduling_test")

  pool = new pg.Pool({
    connectionString: `postgres://cortex:cortex_test@localhost:${PG_PORT}/cortex_memory_scheduling_test`,
  })

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
  workerUtils = await makeWorkerUtils({ pgPool: pool })
}, 60_000)

afterAll(async () => {
  if (workerUtils) await workerUtils.release()
  if (runner) await runner.stop()
  if (db) await db.destroy()
  if (pool) await pool.end()
  if (embeddedPg) await embeddedPg.stop()
}, 30_000)

beforeEach(async () => {
  if (runner) {
    await runner.stop()
  }

  await db.deleteFrom("memory_extract_message").execute()
  await db.deleteFrom("memory_extract_session_state").execute()
  await db.deleteFrom("job").execute()
  await db.deleteFrom("session").execute()
  await db.deleteFrom("agent").execute()
  await db.deleteFrom("user_account").execute()
})

describe("memory extraction scheduling", () => {
  it("enqueues extraction at threshold and drains remaining messages at job end", async () => {
    const llmCall = vi.fn<LLMCaller>().mockResolvedValue(
      JSON.stringify({
        facts: [
          {
            content: "The user wants memory extraction scheduling in place",
            type: "fact",
            confidence: 0.9,
            importance: 4,
            tags: ["memory", "scheduler"],
            people: [],
            projects: ["cortex"],
            source: { sessionId: "s", turnIndex: 0, timestamp: new Date().toISOString() },
            supersedes: [],
          },
        ],
      }),
    )

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "first response" },
      { type: "text", timestamp: new Date().toISOString(), content: "second response" },
      { type: "complete", timestamp: new Date().toISOString(), result: createResult("completed") },
    ]

    const registry = await createRegistry(createHandle(events, createResult("completed")))
    const store = mockStore()

    runner = await run({
      pgPool: pool,
      taskList: {
        agent_execute: createAgentExecuteTask({ db, registry, memoryExtractThreshold: 2 }),
        memory_extract: createMemoryExtractTask(
          { memoryStore: store, llmCall, embed: mockEmbed },
          db,
        ),
      },
      concurrency: 2,
      noHandleSignals: true,
    })

    const user = await db
      .insertInto("user_account")
      .values({ display_name: "memory tester" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const agent = await db
      .insertInto("agent")
      .values({ name: "agent-mem", slug: "agent-mem", role: "test" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const session = await db
      .insertInto("session")
      .values({ agent_id: agent.id, user_account_id: user.id, status: "active", metadata: {} })
      .returning("id")
      .executeTakeFirstOrThrow()
    const job = await db
      .insertInto("job")
      .values({
        agent_id: agent.id,
        session_id: session.id,
        payload: { prompt: "remember this conversation", goalType: "research" },
        max_attempts: 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    await db.updateTable("job").set({ status: "SCHEDULED" }).where("id", "=", job.id).execute()
    await workerUtils.addJob("agent_execute", { jobId: job.id }, { maxAttempts: 1 })

    await waitFor(async () => {
      const state = await db
        .selectFrom("memory_extract_session_state")
        .select(["pending_count", "total_count"])
        .where("session_id", "=", session.id)
        .executeTakeFirst()
      const status = await db
        .selectFrom("job")
        .select("status")
        .where("id", "=", job.id)
        .executeTakeFirst()
      return status?.status === "COMPLETED" && state?.pending_count === 0 && state.total_count === 3
    })

    const messages = await db
      .selectFrom("memory_extract_message")
      .select(["id", "extracted_at"])
      .where("session_id", "=", session.id)
      .orderBy("id", "asc")
      .execute()

    expect(messages).toHaveLength(3)
    expect(messages.every((row) => row.extracted_at !== null)).toBe(true)
    expect(llmCall.mock.calls.length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it("flushes pending extraction windows after restart recovery", async () => {
    const llmCall = vi.fn<LLMCaller>().mockResolvedValue(
      JSON.stringify({
        facts: [
          {
            content: "Recovery flush replayed pending session messages",
            type: "fact",
            confidence: 0.8,
            importance: 3,
            tags: ["recovery"],
            people: [],
            projects: ["cortex"],
            source: { sessionId: "s", turnIndex: 0, timestamp: new Date().toISOString() },
            supersedes: [],
          },
        ],
      }),
    )
    const store = mockStore()

    runner = await run({
      pgPool: pool,
      taskList: {
        memory_extract: createMemoryExtractTask(
          { memoryStore: store, llmCall, embed: mockEmbed },
          db,
        ),
      },
      concurrency: 1,
      noHandleSignals: true,
    })

    const user = await db
      .insertInto("user_account")
      .values({ display_name: "restart tester" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const agent = await db
      .insertInto("agent")
      .values({ name: "agent-restart", slug: "agent-restart", role: "test" })
      .returning("id")
      .executeTakeFirstOrThrow()
    const session = await db
      .insertInto("session")
      .values({ agent_id: agent.id, user_account_id: user.id, status: "active", metadata: {} })
      .returning("id")
      .executeTakeFirstOrThrow()

    await db
      .insertInto("memory_extract_message")
      .values([
        {
          session_id: session.id,
          agent_id: agent.id,
          role: "user",
          content: "first pending message",
          occurred_at: new Date(),
        },
        {
          session_id: session.id,
          agent_id: agent.id,
          role: "assistant",
          content: "second pending message",
          occurred_at: new Date(),
        },
      ])
      .execute()

    await db
      .insertInto("memory_extract_session_state")
      .values({ session_id: session.id, pending_count: 2, total_count: 2 })
      .execute()

    const scheduler = createMemoryScheduler({ db, threshold: 50 })
    const flushed = await scheduler.flushAllPending(workerUtils)

    expect(flushed).toBe(1)

    await waitFor(async () => {
      const state = await db
        .selectFrom("memory_extract_session_state")
        .select("pending_count")
        .where("session_id", "=", session.id)
        .executeTakeFirst()
      return state?.pending_count === 0
    })

    const rows = await db
      .selectFrom("memory_extract_message")
      .select("extracted_at")
      .where("session_id", "=", session.id)
      .execute()
    expect(rows.every((row) => row.extracted_at !== null)).toBe(true)
    expect(llmCall).toHaveBeenCalledTimes(1)
  }, 30_000)
})
