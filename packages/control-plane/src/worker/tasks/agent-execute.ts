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

import type {
  BackendRegistry,
  ExecutionHandle,
  ExecutionResult,
  ExecutionStatus,
  ExecutionTask,
  OutputEvent,
} from "@cortex/shared/backends"
import type { BufferWriter } from "@cortex/shared/buffer"
import type { ResolvedSkills } from "@cortex/shared/skills"
import { CortexAttributes, injectTraceContext, withSpan } from "@cortex/shared/tracing"
import type { JobHelpers, Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database, Job } from "../../db/types.js"
import type { SSEConnectionManager } from "../../streaming/manager.js"
import type { AgentOutputPayload } from "../../streaming/types.js"
import { classifyError } from "../error-classifier.js"
import { startHeartbeat } from "../heartbeat.js"
import { createMemoryScheduler } from "../memory-scheduler.js"
import { calculateRunAt } from "../retry.js"

export interface AgentExecutePayload {
  jobId: string
}

export interface AgentExecuteDeps {
  db: Kysely<Database>
  registry: BackendRegistry
  streamManager?: SSEConnectionManager
  sessionBufferFactory?: (jobId: string, agentId: string) => BufferWriter
  memoryExtractThreshold?: number
  /** Optional skill index for dynamic skill loading. */
  skillIndex?: import("@cortex/shared/skills").SkillIndex
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
  const {
    db,
    registry,
    streamManager,
    sessionBufferFactory,
    memoryExtractThreshold = 50,
    skillIndex,
  } = deps
  const memoryScheduler = createMemoryScheduler({ db, threshold: memoryExtractThreshold })

  return async (rawPayload: unknown, _helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as AgentExecutePayload
    const { jobId } = payload

    await withSpan("cortex.job.execute", async (rootSpan) => {
      rootSpan.setAttribute(CortexAttributes.JOB_ID, jobId)

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

      rootSpan.setAttribute(CortexAttributes.AGENT_ID, job.agent_id)

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

        rootSpan.setAttribute(CortexAttributes.AGENT_NAME, agent.name)

        // ── Step 2: Check approval gate ──
        const agentConfig = agent.model_config
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
            rootSpan.addEvent("approval_gate_waiting")
            return
          }
        }

        // ── Step 3: Resolve skills (if skill index is available) ──
        let resolvedSkills: ResolvedSkills | null = null

        if (skillIndex) {
          try {
            await skillIndex.refresh()
            const { loadResolvedSkillsFromIndex } =
              await import("../../lifecycle/skill-resolver.js")
            resolvedSkills = await loadResolvedSkillsFromIndex(skillIndex, agent, job)
          } catch {
            // Skill loading is non-fatal — proceed without.
          }
        }

        // ── Step 4: Build ExecutionTask (needed for routing) ──
        const task = buildExecutionTask(job, agent, agentConfig, resolvedSkills)

        // Inject trace context into task environment for downstream propagation
        const traceHeaders = injectTraceContext()
        if (traceHeaders.traceparent) {
          task.context.environment = {
            ...task.context.environment,
            TRACEPARENT: traceHeaders.traceparent,
          }
        }

        // ── Step 5: Resolve backend via router (failover-aware) or direct lookup ──
        const preferredBackendId =
          typeof agentConfig.backendId === "string" ? agentConfig.backendId : undefined
        const { backend, providerId } = registry.routeTask(task, preferredBackendId)

        rootSpan.setAttribute(CortexAttributes.BACKEND_ID, backend.backendId)
        rootSpan.setAttribute(CortexAttributes.PROVIDER_ID, providerId)

        // ── Step 6: Acquire semaphore permit ──
        const permit = await registry.acquirePermit(backend.backendId, SEMAPHORE_TIMEOUT_MS)

        let handle: ExecutionHandle | undefined
        let bufferWriter: BufferWriter | undefined

        try {
          // ── Step 7: Initialize JSONL session buffer ──
          if (sessionBufferFactory) {
            bufferWriter = sessionBufferFactory(jobId, agent.id)
          }

          // ── Step 8: Execute task ──
          handle = await backend.executeTask(task)

          // Store the user prompt as a session message for memory extraction batching.
          if (job.session_id && task.instruction.prompt.trim().length > 0) {
            await memoryScheduler
              .recordMessage(
                {
                  sessionId: job.session_id,
                  agentId: agent.id,
                  role: "user",
                  content: task.instruction.prompt,
                  occurredAt: new Date().toISOString(),
                },
                _helpers,
              )
              .catch(() => {
                // Non-fatal: extraction scheduling must not block execution.
              })
          }

          // ── Step 9: Stream events ──
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

              if (job.session_id && event.type === "text" && event.content.trim().length > 0) {
                await memoryScheduler
                  .recordMessage(
                    {
                      sessionId: job.session_id,
                      agentId: agent.id,
                      role: "assistant",
                      content: event.content,
                      occurredAt: event.timestamp,
                    },
                    _helpers,
                  )
                  .catch(() => {
                    // Non-fatal: extraction scheduling must not block execution.
                  })
              }
            }
          } finally {
            cancelChecker.stop()
          }

          // ── Step 10: Await final result ──
          const result = await handle.result()

          // ── Step 11: Record outcome for circuit breaker ──
          const success = result.status === "completed"
          registry.recordOutcome(providerId, success, result.error?.classification)

          rootSpan.setAttribute(CortexAttributes.EXECUTION_STATUS, result.status)
          rootSpan.setAttribute(CortexAttributes.EXECUTION_DURATION_MS, result.durationMs)

          // ── Step 12: Map status and persist result ──
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

        rootSpan.setAttribute(CortexAttributes.ERROR_CATEGORY, classification.category)

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

        throw err // re-throw so withSpan marks the span as errored
      } finally {
        if (job.session_id) {
          await memoryScheduler.flushSession(job.session_id, _helpers).catch(() => {
            // Non-fatal: best-effort final flush.
          })
        }
        heartbeat.stop()
      }
    }) // end withSpan
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
  resolvedSkills?: ResolvedSkills | null,
): ExecutionTask {
  const payload = job.payload
  const skillConfig = agent.skill_config
  const resourceLimits = agent.resource_limits

  // Base agent constraints from skill_config
  let allowedTools: string[] = Array.isArray(skillConfig.allowedTools)
    ? (skillConfig.allowedTools as string[])
    : []
  let deniedTools: string[] = Array.isArray(skillConfig.deniedTools)
    ? (skillConfig.deniedTools as string[])
    : []
  let networkAccess: boolean =
    typeof skillConfig.networkAccess === "boolean" ? skillConfig.networkAccess : false
  let shellAccess: boolean =
    typeof skillConfig.shellAccess === "boolean" ? skillConfig.shellAccess : true

  // Apply resolved skill constraints (narrowing only)
  let skillInstructions: string | undefined
  if (resolvedSkills && resolvedSkills.selected.length > 0) {
    const merged = resolvedSkills.mergedConstraints

    // Narrow allowedTools: intersect if both specify
    if (merged.allowedTools.length > 0 && allowedTools.length > 0) {
      const skillSet = new Set(merged.allowedTools)
      allowedTools = allowedTools.filter((t) => skillSet.has(t))
    } else if (merged.allowedTools.length > 0) {
      allowedTools = [...merged.allowedTools]
    }

    // Widen deniedTools: union
    const deniedSet = new Set([...deniedTools, ...merged.deniedTools])
    deniedTools = [...deniedSet]

    // AND boolean flags
    networkAccess = networkAccess && merged.networkAccess
    shellAccess = shellAccess && merged.shellAccess

    // Build skill instructions for progressive disclosure
    const parts: string[] = []
    if (resolvedSkills.summaries.length > 0) {
      const summaryLines = resolvedSkills.summaries.map(
        (s) => `- ${s.title} [${s.tags.join(", ")}]: ${s.summary}`,
      )
      parts.push(`Available skills:\n${summaryLines.join("\n")}`)
    }
    for (const skill of resolvedSkills.selected) {
      parts.push(`## Skill: ${skill.metadata.title}\n\n${skill.content.trim()}`)
    }
    if (parts.length > 0) {
      skillInstructions = parts.join("\n\n")
    }
  }

  return {
    id: job.id,
    jobId: job.id,
    agentId: agent.id,
    instruction: {
      prompt: typeof payload.prompt === "string" ? payload.prompt : JSON.stringify(payload),
      goalType:
        typeof payload.goalType === "string"
          ? (payload.goalType as ExecutionTask["instruction"]["goalType"])
          : "code_edit",
      targetFiles: Array.isArray(payload.targetFiles)
        ? (payload.targetFiles as string[])
        : undefined,
      conversationHistory: Array.isArray(payload.conversationHistory)
        ? (payload.conversationHistory as ExecutionTask["instruction"]["conversationHistory"])
        : undefined,
    },
    context: {
      workspacePath:
        typeof agentConfig.workspacePath === "string" ? agentConfig.workspacePath : "/workspace",
      systemPrompt:
        typeof agentConfig.systemPrompt === "string"
          ? agentConfig.systemPrompt
          : `You are ${agent.name}, a ${agent.role} agent.${agent.description ? ` ${agent.description}` : ""}`,
      memories: Array.isArray(payload.memories) ? (payload.memories as string[]) : [],
      relevantFiles:
        typeof payload.relevantFiles === "object" && payload.relevantFiles !== null
          ? (payload.relevantFiles as Record<string, string>)
          : {},
      environment:
        typeof agentConfig.environment === "object" && agentConfig.environment !== null
          ? (agentConfig.environment as Record<string, string>)
          : {},
      skillInstructions,
    },
    constraints: {
      timeoutMs: job.timeout_seconds * 1000,
      maxTokens: typeof resourceLimits.maxTokens === "number" ? resourceLimits.maxTokens : 200_000,
      model:
        typeof agentConfig.model === "string" ? agentConfig.model : "claude-sonnet-4-5-20250514",
      allowedTools,
      deniedTools,
      maxTurns: typeof resourceLimits.maxTurns === "number" ? resourceLimits.maxTurns : 25,
      networkAccess,
      shellAccess,
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
