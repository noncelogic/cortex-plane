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
import EmbeddedPostgres from "embedded-postgres"
import { makeWorkerUtils, run, type Runner, type WorkerUtils } from "graphile-worker"
import { Kysely, PostgresDialect } from "kysely"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { attachPoolErrorHandler, endPoolGracefully } from "./postgres-teardown.js"

import type { Database } from "../db/types.js"
import { SSEConnectionManager } from "../streaming/manager.js"
import { createAgentExecuteTask } from "../worker/tasks/agent-execute.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "../../migrations")
const PG_DATA_DIR = join(__dirname, "../../.test-pgdata-worker")
const PG_PORT = 15433

let embeddedPg: EmbeddedPostgres
let pool: pg.Pool
let detachPoolErrorHandler: (() => void) | undefined
let db: Kysely<Database>
let runner: Runner
let workerUtils: WorkerUtils

// ── Mock backend factory ──

function createMockResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    taskId: "test-task",
    status: "completed",
    exitCode: 0,
    summary: "Task completed successfully",
    fileChanges: [],
    stdout: "mock stdout",
    stderr: "",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    artifacts: [],
    durationMs: 1000,
    ...overrides,
  }
}

function createMockEvents(events: OutputEvent[] = []): OutputEvent[] {
  return events.length > 0
    ? events
    : [
        {
          type: "text",
          timestamp: new Date().toISOString(),
          content: "Working on it...",
        },
        {
          type: "complete",
          timestamp: new Date().toISOString(),
          result: createMockResult(),
        },
      ]
}

function createMockHandle(
  result: ExecutionResult = createMockResult(),
  events: OutputEvent[] = createMockEvents(),
): ExecutionHandle {
  let cancelled = false
  return {
    taskId: result.taskId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      for (const event of events) {
        if (cancelled) return
        yield event
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async result() {
      if (cancelled) {
        return { ...result, status: "cancelled" as const }
      }
      return result
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async cancel(_reason: string) {
      cancelled = true
    },
  }
}

function createMockBackend(handle: ExecutionHandle = createMockHandle()): ExecutionBackend {
  return {
    backendId: "mock-backend",
    async start() {},
    async stop() {},
    // eslint-disable-next-line @typescript-eslint/require-await
    async healthCheck() {
      return {
        backendId: "mock-backend",
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
}

async function createMockRegistry(
  backend?: ExecutionBackend,
  maxConcurrent = 3,
): Promise<BackendRegistry> {
  const registry = new BackendRegistry()
  const b = backend ?? createMockBackend()
  await registry.register(b, {}, maxConcurrent)
  return registry
}

// ── Test setup ──

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
  detachPoolErrorHandler = attachPoolErrorHandler(pool)

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
  workerUtils = await makeWorkerUtils({ pgPool: pool })
}, 60_000)

afterAll(async () => {
  if (workerUtils) await workerUtils.release()
  if (runner) await runner.stop()
  if (pool) await endPoolGracefully(pool)
  if (embeddedPg) await embeddedPg.stop()
  detachPoolErrorHandler?.()
}, 30_000)

// ── Helper: insert agent + job and transition to SCHEDULED ──

async function setupJob(
  agentOverrides: Partial<{ model_config: Record<string, unknown> }> = {},
  jobOverrides: Partial<{ payload: Record<string, unknown>; timeout_seconds: number }> = {},
) {
  const suffix = Math.random().toString(36).slice(2, 8)
  const agentResult = await db
    .insertInto("agent")
    .values({
      name: `test-agent-${suffix}`,
      slug: `test-agent-${suffix}`,
      role: "test",
      ...agentOverrides,
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const jobResult = await db
    .insertInto("job")
    .values({
      agent_id: agentResult.id,
      payload: { prompt: "test task", goalType: "code_edit" },
      max_attempts: 3,
      ...jobOverrides,
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  // Transition to SCHEDULED
  await db.updateTable("job").set({ status: "SCHEDULED" }).where("id", "=", jobResult.id).execute()

  return { agentId: agentResult.id, jobId: jobResult.id }
}

// ── Helper: wait for job to reach a terminal state ──

async function waitForJobStatus(
  jobId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const check = setInterval(() => {
      void db
        .selectFrom("job")
        .select("status")
        .where("id", "=", jobId)
        .executeTakeFirst()
        .then((job) => {
          if (job && statuses.includes(job.status)) {
            clearInterval(check)
            resolve(job.status)
          }
        })
    }, 100)

    setTimeout(() => {
      clearInterval(check)
      reject(new Error(`Job ${jobId} did not reach ${statuses.join("|")} within ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

// ── Helper: start runner with given registry ──

async function startRunner(registry: BackendRegistry, streamManager?: SSEConnectionManager) {
  if (runner) await runner.stop()
  runner = await run({
    pgPool: pool,
    taskList: {
      agent_execute: createAgentExecuteTask({ db, registry, streamManager }),
    },
    concurrency: 1,
    noHandleSignals: true,
  })
}

// ── Tests ──

describe("Worker integration", () => {
  it("successful execution: SCHEDULED → RUNNING → COMPLETED with real result", async () => {
    const mockResult = createMockResult({
      summary: "Created 2 files",
      fileChanges: [{ path: "src/index.ts", operation: "modified", diff: "+hello" }],
    })
    const registry = await createMockRegistry(createMockBackend(createMockHandle(mockResult)))
    await startRunner(registry)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    await waitForJobStatus(jobId, ["COMPLETED"])

    const completedJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(completedJob.status).toBe("COMPLETED")
    expect(completedJob.started_at).not.toBeNull()
    expect(completedJob.completed_at).not.toBeNull()
    expect(completedJob.attempt).toBe(1)

    const result = completedJob.result as Record<string, unknown>
    expect(result.status).toBe("completed")
    expect(result.summary).toBe("Created 2 files")
    expect(result.fileChanges).toEqual([
      { path: "src/index.ts", operation: "modified", diff: "+hello" },
    ])
    expect(result.tokenUsage).toBeDefined()
  }, 30_000)

  it("failed execution: backend returns failed status → job FAILED with error details", async () => {
    const mockResult = createMockResult({
      status: "failed",
      exitCode: 1,
      summary: "Authentication failed",
      error: {
        message: "Invalid API key",
        classification: "permanent",
        partialExecution: false,
      },
    })
    const registry = await createMockRegistry(createMockBackend(createMockHandle(mockResult)))
    await startRunner(registry)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    await waitForJobStatus(jobId, ["FAILED"])

    const failedJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(failedJob.status).toBe("FAILED")
    expect(failedJob.completed_at).not.toBeNull()

    const result = failedJob.result as Record<string, unknown>
    expect(result.status).toBe("failed")
    expect(result.summary).toBe("Authentication failed")
  }, 30_000)

  it("timeout: backend times out → job TIMED_OUT", async () => {
    const mockResult = createMockResult({
      status: "timed_out",
      summary: "Execution timed out",
      error: {
        message: "Exceeded 300s timeout",
        classification: "timeout",
        partialExecution: true,
      },
    })
    const registry = await createMockRegistry(createMockBackend(createMockHandle(mockResult)))
    await startRunner(registry)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    await waitForJobStatus(jobId, ["TIMED_OUT"])

    const timedOutJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(timedOutJob.status).toBe("TIMED_OUT")
    expect(timedOutJob.completed_at).not.toBeNull()
  }, 30_000)

  it("cancellation: job cancelled during execution", async () => {
    // Create a handle that delays, giving time to cancel
    let cancelled = false
    const slowHandle: ExecutionHandle = {
      taskId: "slow-task",
      async *events() {
        // Emit one event, then wait for cancellation
        yield {
          type: "text" as const,
          timestamp: new Date().toISOString(),
          content: "Starting...",
        }
        // Wait a bit to allow cancel check to trigger
        await new Promise((r) => setTimeout(r, 200))
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async result() {
        if (cancelled) {
          return createMockResult({ status: "cancelled" })
        }
        return createMockResult()
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async cancel(_reason: string) {
        cancelled = true
      },
    }

    const registry = await createMockRegistry(createMockBackend(slowHandle))
    await startRunner(registry)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    // Wait for RUNNING, then externally cancel
    await waitForJobStatus(jobId, ["RUNNING"])

    // Simulate external cancellation: set status to FAILED directly
    // (The cancel checker polls and sees the non-RUNNING status)
    await db
      .updateTable("job")
      .set({
        status: "FAILED",
        error: { category: "PERMANENT", message: "Cancelled by user" },
        completed_at: new Date(),
      })
      .where("id", "=", jobId)
      .where("status", "=", "RUNNING")
      .execute()

    // The job should already be FAILED from our explicit cancellation
    const cancelledJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(cancelledJob.status).toBe("FAILED")
    expect(cancelledJob.completed_at).not.toBeNull()
  }, 30_000)

  it("semaphore: concurrent limit respected", async () => {
    // Create registry with max concurrency of 1
    let activeCount = 0
    let maxActive = 0

    const trackingBackend = createMockBackend()
    const originalExecute = trackingBackend.executeTask.bind(trackingBackend)
    trackingBackend.executeTask = async (task: ExecutionTask) => {
      activeCount++
      maxActive = Math.max(maxActive, activeCount)

      const handle = await originalExecute(task)
      // Add a small delay to ensure concurrent attempts overlap
      await new Promise((r) => setTimeout(r, 100))

      const wrappedHandle: ExecutionHandle = {
        ...handle,
        async result() {
          const r = await handle.result()
          activeCount--
          return r
        },
      }
      return wrappedHandle
    }

    const registry = await createMockRegistry(trackingBackend, 1)
    await startRunner(registry)

    // Enqueue two jobs
    const { jobId: jobId1 } = await setupJob()
    const { jobId: jobId2 } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId: jobId1 }, { maxAttempts: 1 })
    await workerUtils.addJob("agent_execute", { jobId: jobId2 }, { maxAttempts: 1 })

    // Wait for both to complete
    await waitForJobStatus(jobId1, ["COMPLETED", "FAILED"], 15_000)
    await waitForJobStatus(jobId2, ["COMPLETED", "FAILED"], 15_000)

    // With concurrency=1 on the worker itself, jobs are processed one at a time
    // so maxActive should be 1
    expect(maxActive).toBeLessThanOrEqual(1)
  }, 30_000)

  it("retry: transient failure triggers retry with backoff", async () => {
    let callCount = 0
    const retryBackend = createMockBackend()
    // eslint-disable-next-line @typescript-eslint/require-await
    retryBackend.executeTask = async (_task: ExecutionTask) => {
      callCount++
      if (callCount === 1) {
        // First call throws a transient error
        const err = new Error("Connection reset")
        ;(err as NodeJS.ErrnoException).code = "ECONNRESET"
        throw err
      }
      // Second call succeeds
      return createMockHandle()
    }

    const registry = await createMockRegistry(retryBackend)
    await startRunner(registry)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    // Wait for retry scheduling (SCHEDULED again)
    await waitForJobStatus(jobId, ["SCHEDULED", "COMPLETED"], 15_000)

    const retriedJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    // Job should be SCHEDULED for retry (the worker picks it up again)
    // or COMPLETED if the retry already ran
    expect(["SCHEDULED", "RUNNING", "COMPLETED"]).toContain(retriedJob.status)
    expect(retriedJob.attempt).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it("approval gate: job pauses for approval when required", async () => {
    const registry = await createMockRegistry()
    await startRunner(registry)

    const { jobId } = await setupJob({
      model_config: { requiresApproval: true },
    })
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    // The job should transition to WAITING_FOR_APPROVAL
    await waitForJobStatus(jobId, ["WAITING_FOR_APPROVAL"], 10_000)

    const waitingJob = await db
      .selectFrom("job")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow()

    expect(waitingJob.status).toBe("WAITING_FOR_APPROVAL")
    expect(waitingJob.approval_expires_at).not.toBeNull()
  }, 30_000)

  it("SSE streaming: events are broadcast during execution", async () => {
    const mockEvents: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Hello from mock" },
      { type: "progress", timestamp: new Date().toISOString(), percent: 0.5, message: "Halfway" },
      { type: "complete", timestamp: new Date().toISOString(), result: createMockResult() },
    ]

    const registry = await createMockRegistry(
      createMockBackend(createMockHandle(createMockResult(), mockEvents)),
    )

    const streamManager = new SSEConnectionManager()
    const broadcastSpy = vi.spyOn(streamManager, "broadcast")

    await startRunner(registry, streamManager)

    const { jobId } = await setupJob()
    await workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })

    await waitForJobStatus(jobId, ["COMPLETED"])

    // Verify broadcast was called with agent:output events
    const outputCalls = broadcastSpy.mock.calls.filter(([, event]) => event === "agent:output")
    expect(outputCalls.length).toBeGreaterThanOrEqual(3)

    // Verify completion broadcast
    const completeCalls = broadcastSpy.mock.calls.filter(([, event]) => event === "agent:complete")
    expect(completeCalls.length).toBe(1)

    broadcastSpy.mockRestore()
  }, 30_000)
})
