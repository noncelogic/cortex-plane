/**
 * Graphile Worker initialization.
 *
 * Configures the worker with:
 * - PostgreSQL connection (shared pool)
 * - Task handlers (agent_execute, memory_extract, correction_strengthen, proactive_detect)
 * - Concurrency (env GRAPHILE_WORKER_CONCURRENCY, default 5)
 *
 * The runner is started alongside Fastify and shares the same pg.Pool.
 */

import type { BackendRegistry } from "@cortex/shared/backends"
import type { BufferWriter } from "@cortex/shared/buffer"
import { run, type Runner, type TaskList } from "graphile-worker"
import type { Kysely } from "kysely"
import type { Pool } from "pg"

import type { AuthOAuthConfig } from "../config.js"
import type { Database } from "../db/types.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import type { SSEConnectionManager } from "../streaming/manager.js"
import { createAgentExecuteTask } from "./tasks/agent-execute.js"
import { createApprovalExpireTask } from "./tasks/approval-expire.js"
import { createCorrectionStrengthenTask } from "./tasks/correction-strengthen.js"
import { createCredentialRefreshTask } from "./tasks/credential-refresh.js"
import { createMemoryExtractTask } from "./tasks/memory-extract.js"
import { createProactiveDetectTask } from "./tasks/proactive-detect.js"

export interface WorkerOptions {
  pgPool: Pool
  db: Kysely<Database>
  registry: BackendRegistry
  streamManager?: SSEConnectionManager
  sessionBufferFactory?: (jobId: string, agentId: string) => BufferWriter
  memoryExtractThreshold?: number
  concurrency?: number
  /** Optional MCP tool router for resolving MCP tools in agent registries. */
  mcpToolRouter?: McpToolRouter
  /** OAuth config for proactive credential refresh (optional — task is no-op if absent). */
  authConfig?: AuthOAuthConfig
}

/**
 * Create and start the Graphile Worker runner.
 * Returns the Runner instance (used for shutdown and health checks).
 */
export async function createWorker(options: WorkerOptions): Promise<Runner> {
  const {
    pgPool,
    db,
    registry,
    streamManager,
    sessionBufferFactory,
    memoryExtractThreshold,
    concurrency,
    mcpToolRouter,
    authConfig,
  } = options

  const workerConcurrency =
    concurrency ?? parseInt(process.env.GRAPHILE_WORKER_CONCURRENCY ?? "5", 10)

  const taskList: TaskList = {
    agent_execute: createAgentExecuteTask({
      db,
      registry,
      streamManager,
      sessionBufferFactory,
      memoryExtractThreshold,
      mcpToolRouter,
    }),
    memory_extract: createMemoryExtractTask(undefined, db),
    approval_expire: createApprovalExpireTask(db),
    correction_strengthen: createCorrectionStrengthenTask(),
    proactive_detect: createProactiveDetectTask(),
    ...(authConfig ? { credential_refresh: createCredentialRefreshTask(db, authConfig) } : {}),
  }

  const runner = await run({
    pgPool,
    taskList,
    concurrency: workerConcurrency,
    noHandleSignals: true, // We handle SIGTERM ourselves in shutdown.ts
    crontab: [
      // Expire stale approval requests every 60 seconds
      "* * * * * approval_expire ?max=1",
      // Proactive OAuth token refresh every 15 minutes
      ...(authConfig
        ? ["*/15 * * * * credential_refresh ?jobKey=credential_refresh_periodic&jobKeyMode=preserve_run_at&max=1"]
        : []),
    ].join("\n"),
  })

  return runner
}

export type { Runner } from "graphile-worker"
