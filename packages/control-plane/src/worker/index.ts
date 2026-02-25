/**
 * Graphile Worker initialization.
 *
 * Configures the worker with:
 * - PostgreSQL connection (shared pool)
 * - Task handlers (agent_execute, memory_extract)
 * - Concurrency (env GRAPHILE_WORKER_CONCURRENCY, default 5)
 *
 * The runner is started alongside Fastify and shares the same pg.Pool.
 */

import { run, type Runner, type TaskList } from "graphile-worker"
import type { Kysely } from "kysely"
import type { Pool } from "pg"

import type { BackendRegistry } from "@cortex/shared/backends"
import type { BufferWriter } from "@cortex/shared/buffer"
import type { Database } from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"
import { createAgentExecuteTask } from "./tasks/agent-execute.js"
import { createApprovalExpireTask } from "./tasks/approval-expire.js"
import { createMemoryExtractTask } from "./tasks/memory-extract.js"

export interface WorkerOptions {
  pgPool: Pool
  db: Kysely<Database>
  registry: BackendRegistry
  streamManager?: SSEConnectionManager
  sessionBufferFactory?: (jobId: string, agentId: string) => BufferWriter
  concurrency?: number
}

/**
 * Create and start the Graphile Worker runner.
 * Returns the Runner instance (used for shutdown and health checks).
 */
export async function createWorker(options: WorkerOptions): Promise<Runner> {
  const { pgPool, db, registry, streamManager, sessionBufferFactory, concurrency } = options

  const workerConcurrency =
    concurrency ?? parseInt(process.env.GRAPHILE_WORKER_CONCURRENCY ?? "5", 10)

  const taskList: TaskList = {
    agent_execute: createAgentExecuteTask({ db, registry, streamManager, sessionBufferFactory }),
    memory_extract: createMemoryExtractTask(),
    approval_expire: createApprovalExpireTask(db),
  }

  const runner = await run({
    pgPool,
    taskList,
    concurrency: workerConcurrency,
    noHandleSignals: true, // We handle SIGTERM ourselves in shutdown.ts
    crontab: [
      // Expire stale approval requests every 60 seconds
      "* * * * * approval_expire ?max=1",
    ].join("\n"),
  })

  return runner
}

export type { Runner } from "graphile-worker"
