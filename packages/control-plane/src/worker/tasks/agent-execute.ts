/**
 * Main agent execution task — "agent_execute"
 *
 * Receives a job payload from the Graphile Worker queue and drives the
 * job through its lifecycle:
 *   SCHEDULED → RUNNING → COMPLETED | FAILED | TIMED_OUT
 *
 * Wires real execution dispatch through the BackendRegistry, streams
 * output events to JSONL session buffer and SSE manager, and handles
 * cancellation and approval gates.
 */

import type { JobHelpers, Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type {
  BackendRegistry,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExecutionTask,
  OutputEvent,
} from "@cortex/shared/backends"
import type { BufferWriter } from "@cortex/shared/buffer"
import type { Database, Job } from "../../db/types.js"
import type { SSEConnectionManager } from "../../streaming/manager.js"
import type { AgentOutputPayload } from "../../streaming/types.js"
import { classifyError } from "../error-classifier.js"
import { startHeartbeat } from "../heartbeat.js"
import { calculateRunAt } from "../retry.js"

export interface AgentExecutePayload {
  jobId: string
}

export interface AgentExecuteDeps {
  db: Kysely<Database>
  registry: BackendRegistry
  streamManager?: SSEConnectionManager
  sessionBufferFactory?: (jobId: string, agentId: string) => BufferWriter
}

/** Polling interval (ms) for checking cancellation. */
const CANCEL_CHECK_INTERVAL_MS = 5_000

/** Semaphore acquisition timeout (ms). */
const SEMAPHORE_TIMEOUT_MS = 60_000

/**
 * Create the agent_execute task handler.
 * Accepts dependencies via closure for dependency injection.
 */
export function createAgentExecuteTask(deps: AgentExecuteDeps): Task {
  const { db, registry, streamManager, sessionBufferFactory } = deps

  return async (rawPayload: unknown, _helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as AgentExecutePayload
    const { jobId } = payload

    // Load the job and validate it's in SCHEDULED state
    const job = await db.selectFrom("job").selectAll().where("id", "=", jobId).executeTakeFirst()

    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    if (job.status !== "SCHEDULED") {
      // Job is not in the expected state — skip silently.
      // This can happen if the job was cancelled or failed by another process.
      return
    }

    // Transition SCHEDULED → RUNNING
    await db
      .updateTable("job")
      .set({
        status: "RUNNING",
        started_at: new Date(),
        heartbeat_at: new Date(),
        attempt: job.attempt + 1,
      })
      .where("id", "=", jobId)
      .where("status", "=", "SCHEDULED")
      .execute()

    // Start heartbeat writer (updates heartbeat_at every 30s)
    const heartbeat = startHeartbeat(jobId, db)

    try {
      // ── Step 1: Load agent definition ──
      const agent = await db
        .selectFrom("agent")
        .selectAll()
        .where("id", "=", job.agent_id)
        .executeTakeFirst()

      if (!agent) {
        throw new Error(`Agent ${job.agent_id} not found for job ${jobId}`)
      }

      if (agent.status !== "ACTIVE") {
        throw new Error(`Agent ${agent.name} is ${agent.status}, cannot execute`)
      }

      // ── Step 2: Check approval gate ──
      const agentConfig = agent.model_config as Record<string, unknown>
      if (agentConfig.requiresApproval === true) {
        const approved = await checkApprovalGate(db, job)
        if (!approved) {
          // Transition RUNNING → WAITING_FOR_APPROVAL
          await db
            .updateTable("job")
            .set({
              status: "WAITING_FOR_APPROVAL",
              approval_expires_at: new Date(Date.now() + 3600_000), // 1 hour
            })
            .where("id", "=", jobId)
            .where("status", "=", "RUNNING")
            .execute()

          if (streamManager) {
            streamManager.broadcast(agent.id, "agent:state", {
              agentId: agent.id,
              timestamp: new Date().toISOString(),
              state: "waiting_for_approval",
              reason: "Approval required before execution",
            })
          }
          return
        }
      }

      // ── Step 3: Resolve backend ──
      const backendId =
        typeof agentConfig.backendId === "string"
          ? agentConfig.backendId
          : undefined
      const backend = backendId ? registry.get(backendId) : registry.getDefault()

      if (!backend) {
        throw new Error(
          `No execution backend available${backendId ? ` (requested: ${backendId})` : ""}`,
        )
      }

      // ── Step 4: Acquire semaphore permit ──
      const permit = await registry.acquirePermit(backend.backendId, SEMAPHORE_TIMEOUT_MS)

      let handle: ExecutionHandle | undefined
      let bufferWriter: BufferWriter | undefined

      try {
        // ── Step 5: Build ExecutionTask ──
        const task = buildExecutionTask(job, agent, agentConfig)

        // ── Step 6: Initialize JSONL session buffer ──
        if (sessionBufferFactory) {
          bufferWriter = sessionBufferFactory(jobId, agent.id)
        }

        // ── Step 7: Execute task ──
        handle = await backend.executeTask(task)

        // ── Step 8: Stream events ──
        const cancelChecker = startCancelChecker(db, jobId, handle)

        try {
          for await (const event of handle.events()) {
            // Write to JSONL session buffer
            if (bufferWriter) {
              writeEventToBuffer(bufferWriter, event, jobId, job.session_id ?? "", agent.id)
            }

            // Broadcast to SSE clients
            if (streamManager) {
              const ssePayload: AgentOutputPayload = {
                agentId: agent.id,
                timestamp: event.timestamp,
                output: event,
              }
              streamManager.broadcast(agent.id, "agent:output", ssePayload)
            }
          }
        } finally {
          cancelChecker.stop()
        }

        // ── Step 9: Await final result ──
        const result = await handle.result()

        // ── Step 10: Map status and persist result ──
        const jobStatus = mapExecutionStatus(result.status)

        await db
          .updateTable("job")
          .set({
            status: jobStatus,
            completed_at: new Date(),
            result: executionResultToJson(result),
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()

        // Broadcast completion via SSE
        if (streamManager) {
          streamManager.broadcast(agent.id, "agent:complete", {
            agentId: agent.id,
            timestamp: new Date().toISOString(),
            summary: result.summary,
          })
        }
      } finally {
        permit.release()
        if (bufferWriter) {
          bufferWriter.close()
        }
      }
    } catch (err: unknown) {
      // Classify the error to determine retry behavior
      const classification = classifyError(err)

      if (classification.retryable && job.attempt < job.max_attempts) {
        // Transition RUNNING → FAILED (the trigger allows this),
        // then FAILED → RETRYING will be handled by retry scheduling
        await db
          .updateTable("job")
          .set({
            status: "FAILED",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
            },
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()

        // Transition FAILED → RETRYING
        await db
          .updateTable("job")
          .set({ status: "RETRYING" })
          .where("id", "=", jobId)
          .where("status", "=", "FAILED")
          .execute()

        // Re-enqueue via Graphile Worker with backoff delay
        const runAt = calculateRunAt(job.attempt)
        await _helpers.addJob("agent_execute", { jobId }, { runAt, maxAttempts: 1 })

        // Transition RETRYING → SCHEDULED
        await db
          .updateTable("job")
          .set({ status: "SCHEDULED" })
          .where("id", "=", jobId)
          .where("status", "=", "RETRYING")
          .execute()
      } else if (classification.category === "TIMEOUT") {
        await db
          .updateTable("job")
          .set({
            status: "TIMED_OUT",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
            },
            completed_at: new Date(),
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()
      } else {
        // Permanent failure or retries exhausted
        await db
          .updateTable("job")
          .set({
            status: "FAILED",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
              retriesExhausted: job.attempt >= job.max_attempts,
            },
            completed_at: new Date(),
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()
      }
    } finally {
      heartbeat.stop()
    }
  }
}

// ── Helper: build ExecutionTask from job + agent ──

interface AgentRecord {
  id: string
  name: string
  role: string
  description: string | null
  model_config: Record<string, unknown>
  skill_config: Record<string, unknown>
  resource_limits: Record<string, unknown>
}

function buildExecutionTask(
  job: Job,
  agent: AgentRecord,
  agentConfig: Record<string, unknown>,
): ExecutionTask {
  const payload = job.payload as Record<string, unknown>
  const skillConfig = agent.skill_config as Record<string, unknown>
  const resourceLimits = agent.resource_limits as Record<string, unknown>

  return {
    id: job.id,
    jobId: job.id,
    agentId: agent.id,
    instruction: {
      prompt: typeof payload.prompt === "string" ? payload.prompt : JSON.stringify(payload),
      goalType: typeof payload.goalType === "string"
        ? (payload.goalType as ExecutionTask["instruction"]["goalType"])
        : "code_edit",
      targetFiles: Array.isArray(payload.targetFiles) ? payload.targetFiles as string[] : undefined,
      conversationHistory: Array.isArray(payload.conversationHistory)
        ? (payload.conversationHistory as ExecutionTask["instruction"]["conversationHistory"])
        : undefined,
    },
    context: {
      workspacePath: typeof agentConfig.workspacePath === "string"
        ? agentConfig.workspacePath
        : "/workspace",
      systemPrompt: typeof agentConfig.systemPrompt === "string"
        ? agentConfig.systemPrompt
        : `You are ${agent.name}, a ${agent.role} agent.${agent.description ? ` ${agent.description}` : ""}`,
      memories: Array.isArray(payload.memories) ? payload.memories as string[] : [],
      relevantFiles: typeof payload.relevantFiles === "object" && payload.relevantFiles !== null
        ? (payload.relevantFiles as Record<string, string>)
        : {},
      environment: typeof agentConfig.environment === "object" && agentConfig.environment !== null
        ? (agentConfig.environment as Record<string, string>)
        : {},
    },
    constraints: {
      timeoutMs: job.timeout_seconds * 1000,
      maxTokens: typeof resourceLimits.maxTokens === "number" ? resourceLimits.maxTokens : 200_000,
      model: typeof agentConfig.model === "string" ? agentConfig.model : "claude-sonnet-4-5-20250514",
      allowedTools: Array.isArray(skillConfig.allowedTools)
        ? skillConfig.allowedTools as string[]
        : [],
      deniedTools: Array.isArray(skillConfig.deniedTools)
        ? skillConfig.deniedTools as string[]
        : [],
      maxTurns: typeof resourceLimits.maxTurns === "number" ? resourceLimits.maxTurns : 25,
      networkAccess: typeof skillConfig.networkAccess === "boolean"
        ? skillConfig.networkAccess
        : false,
      shellAccess: typeof skillConfig.shellAccess === "boolean"
        ? skillConfig.shellAccess
        : true,
    },
  }
}

// ── Helper: check approval gate ──

async function checkApprovalGate(db: Kysely<Database>, job: Job): Promise<boolean> {
  const approval = await db
    .selectFrom("approval_request")
    .select("status")
    .where("job_id", "=", job.id)
    .where("status", "=", "APPROVED")
    .executeTakeFirst()

  return approval !== undefined
}

// ── Helper: cancellation checker ──

interface CancelChecker {
  stop(): void
}

function startCancelChecker(
  db: Kysely<Database>,
  jobId: string,
  handle: ExecutionHandle,
): CancelChecker {
  const interval = setInterval(() => {
    void db
      .selectFrom("job")
      .select("status")
      .where("id", "=", jobId)
      .executeTakeFirst()
      .then((row) => {
        // If the job has been transitioned away from RUNNING externally (e.g. cancelled),
        // cancel the execution handle.
        if (row && row.status !== "RUNNING") {
          void handle.cancel("Job status changed to " + row.status)
        }
      })
      .catch(() => {
        // Swallow DB errors during cancel check — heartbeat reaper will catch stale jobs.
      })
  }, CANCEL_CHECK_INTERVAL_MS)

  return {
    stop() {
      clearInterval(interval)
    },
  }
}

// ── Helper: map ExecutionStatus to JobStatus ──

type JobFinalStatus = "COMPLETED" | "FAILED" | "TIMED_OUT"

function mapExecutionStatus(status: ExecutionStatus): JobFinalStatus {
  switch (status) {
    case "completed":
      return "COMPLETED"
    case "failed":
    case "cancelled":
      return "FAILED"
    case "timed_out":
      return "TIMED_OUT"
  }
}

// ── Helper: convert ExecutionResult to JSON-safe record ──

function executionResultToJson(result: ExecutionResult): Record<string, unknown> {
  return {
    taskId: result.taskId,
    status: result.status,
    exitCode: result.exitCode,
    summary: result.summary,
    fileChanges: result.fileChanges,
    tokenUsage: result.tokenUsage,
    artifacts: result.artifacts,
    durationMs: result.durationMs,
    error: result.error ?? null,
  }
}

// ── Helper: map OutputEvent to JSONL buffer EventType ──

function mapOutputEventType(event: OutputEvent): string {
  switch (event.type) {
    case "text":
      return "LLM_RESPONSE"
    case "tool_use":
      return "TOOL_CALL"
    case "tool_result":
      return "TOOL_RESULT"
    case "error":
      return "ERROR"
    case "complete":
      return "SESSION_END"
    default:
      return "LLM_RESPONSE"
  }
}

function writeEventToBuffer(
  writer: BufferWriter,
  event: OutputEvent,
  jobId: string,
  sessionId: string,
  agentId: string,
): void {
  writer.append({
    version: "1.0",
    timestamp: event.timestamp,
    jobId,
    sessionId,
    agentId,
    type: mapOutputEventType(event) as "LLM_RESPONSE",
    data: event as unknown as Record<string, unknown>,
  })
}
