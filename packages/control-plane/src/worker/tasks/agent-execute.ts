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

import type { CredentialService } from "../../auth/credential-service.js"
import type { CredentialResolver } from "../../backends/tools/webhook.js"
import type { Database, Job } from "../../db/types.js"
import type { AgentCircuitBreakerConfig } from "../../lifecycle/agent-circuit-breaker.js"
import { AgentCircuitBreaker } from "../../lifecycle/agent-circuit-breaker.js"
import {
  type ContextBudgetConfig,
  DEFAULT_CONTEXT_BUDGET,
  enforceContextBudget,
  type ExecutionContext,
} from "../../lifecycle/context-budget.js"
import type { AgentLifecycleManager, SteerMessage } from "../../lifecycle/manager.js"
import { recordCircuitBreakerTrip, recordContextBudgetExceeded } from "../../lifecycle/metrics.js"
import type { McpClientPool } from "../../mcp/client-pool.js"
import type { McpToolRouter } from "../../mcp/tool-router.js"
import { CostTracker } from "../../observability/cost-tracker.js"
import type { AgentEventEmitter } from "../../observability/event-emitter.js"
import type { ExecutionRegistry } from "../../observability/execution-registry.js"
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
  /** Optional MCP tool router for resolving MCP tools into agent registries. */
  mcpToolRouter?: McpToolRouter
  /** Optional MCP client pool for registering sidecar targets. */
  mcpClientPool?: McpClientPool
  /** Optional credential service for resolving per-job credentials. */
  credentialService?: CredentialService
  /** Optional lifecycle manager for steer consumption during execution. */
  lifecycleManager?: AgentLifecycleManager
  /** Optional event emitter for persisting structured agent events. */
  eventEmitter?: AgentEventEmitter
  /** Optional execution registry for tracking in-flight handles. */
  executionRegistry?: ExecutionRegistry
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
    mcpToolRouter,
    mcpClientPool,
    credentialService,
    lifecycleManager,
    eventEmitter,
    executionRegistry,
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

      // Circuit breaker + agent ID hoisted for catch-block access
      let agentCB: AgentCircuitBreaker | undefined
      let loadedAgentId: string | undefined

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
        loadedAgentId = agent.id

        // ── Step 1b: Instantiate agent-level circuit breaker ──
        const rawCb = agent.resource_limits.circuitBreaker
        const cbConfig =
          typeof rawCb === "object" && rawCb !== null
            ? (rawCb as Partial<AgentCircuitBreakerConfig>)
            : undefined
        agentCB = new AgentCircuitBreaker(agent.id, cbConfig)

        // Hydrate consecutive failure count from recent jobs
        const recentJobs = await db
          .selectFrom("job")
          .select("status")
          .where("agent_id", "=", agent.id)
          .where("completed_at", "is not", null)
          .orderBy("completed_at", "desc")
          .limit(10)
          .execute()

        for (const rj of recentJobs) {
          if (rj.status === "FAILED") agentCB.recordJobFailure()
          else break
        }

        // ── Step 1c: Pre-dispatch quarantine check ──
        const preCheck = agentCB.shouldQuarantine()
        if (preCheck.quarantine) {
          rootSpan.addEvent("agent_quarantined_pre_dispatch")
          recordCircuitBreakerTrip(agent.id, preCheck.reason)

          if (lifecycleManager) {
            await lifecycleManager.quarantine(agent.id, preCheck.reason).catch(() => {
              // quarantine is best-effort if lifecycle manager doesn't track this agent
            })
          }

          // Update DB agent status directly as a fallback
          await db
            .updateTable("agent")
            .set({ status: "QUARANTINED" })
            .where("id", "=", agent.id)
            .execute()

          await db
            .updateTable("job")
            .set({
              status: "FAILED",
              error: {
                category: "QUARANTINED",
                message: `Agent quarantined: ${preCheck.reason}`,
                attempt: job.attempt + 1,
              },
              completed_at: new Date(),
            })
            .where("id", "=", jobId)
            .where("status", "=", "RUNNING")
            .execute()

          return
        }

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

        // ── Step 4a: Enforce context budget ──
        {
          const rawBudget = agent.resource_limits.contextBudget
          const budgetConfig: ContextBudgetConfig =
            typeof rawBudget === "object" && rawBudget !== null
              ? (rawBudget as ContextBudgetConfig)
              : DEFAULT_CONTEXT_BUDGET

          const identity = agent.description ?? ""
          const execCtx: ExecutionContext = {
            systemPrompt: task.context.systemPrompt,
            identity,
            memory: task.context.memories.join("\n"),
            toolDefinitions: task.context.skillInstructions ?? "",
            conversationHistory: task.instruction.conversationHistory
              ? JSON.stringify(task.instruction.conversationHistory)
              : undefined,
          }

          const { budgetResult, enforcedContext } = enforceContextBudget(execCtx, budgetConfig)

          if (!budgetResult.valid) {
            // Total context exceeds budget — refuse to dispatch
            for (const [comp, budget] of Object.entries(budgetResult.components)) {
              if (budget.truncated) recordContextBudgetExceeded(agent.id, comp)
            }
            rootSpan.addEvent("context_budget_exceeded")

            await db
              .updateTable("job")
              .set({
                status: "FAILED",
                error: {
                  category: "CONTEXT_BUDGET_EXCEEDED",
                  message: budgetResult.warnings.join("; "),
                  attempt: job.attempt + 1,
                },
                completed_at: new Date(),
              })
              .where("id", "=", jobId)
              .where("status", "=", "RUNNING")
              .execute()

            return
          }

          // Apply truncated values back to the task
          task.context.systemPrompt = enforcedContext.systemPrompt
          if (enforcedContext.memory) {
            task.context.memories = [enforcedContext.memory]
          } else {
            task.context.memories = []
          }
          if (task.context.skillInstructions != null) {
            task.context.skillInstructions = enforcedContext.toolDefinitions
          }

          // If identity was truncated and we used auto-generated systemPrompt,
          // rebuild it with the truncated description
          if (
            budgetResult.components["identity"]?.truncated &&
            typeof agentConfig.systemPrompt !== "string"
          ) {
            const desc = enforcedContext.identity
            task.context.systemPrompt = `You are ${agent.name}, a ${agent.role} agent.${desc ? ` ${desc}` : ""}`
          }

          // Log truncation warnings (job still proceeds)
          for (const [comp, budget] of Object.entries(budgetResult.components)) {
            if (budget.truncated) recordContextBudgetExceeded(agent.id, comp)
          }
        }

        // ── Step 4b: Resolve LLM credential from agent_credential_binding ──
        let credentialResolver: CredentialResolver | undefined
        if (credentialService) {
          try {
            const binding = await db
              .selectFrom("agent_credential_binding")
              .innerJoin(
                "provider_credential",
                "provider_credential.id",
                "agent_credential_binding.provider_credential_id",
              )
              .select([
                "provider_credential.user_account_id",
                "provider_credential.provider",
                "provider_credential.credential_class",
              ])
              .where("agent_credential_binding.agent_id", "=", agent.id)
              .where("provider_credential.credential_class", "=", "llm_provider")
              .where("provider_credential.status", "=", "active")
              .executeTakeFirst()

            if (binding) {
              const result = await credentialService.getAccessToken(
                binding.user_account_id,
                binding.provider,
              )
              if (result) {
                task.constraints.llmCredential = {
                  provider: binding.provider,
                  token: result.token,
                  credentialId: result.credentialId,
                }
              }
            }
            // If no binding exists, fall back to env var LLM_API_KEY (backward compat)
          } catch {
            // Credential resolution is non-fatal — fall back to env var
          }

          // Build a credential resolver for tool credential injection
          credentialResolver = buildCredentialResolver(credentialService, db, agent.id, job.id)
        }

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

          // ── Step 7b: Register sidecar targets for stdio MCP servers ──
          if (mcpClientPool && mcpToolRouter) {
            const stdioServers = await db
              .selectFrom("mcp_server")
              .selectAll()
              .where("transport", "=", "stdio")
              .where("status", "!=", "DISABLED")
              .execute()

            const ns =
              typeof agentConfig.namespace === "string" ? agentConfig.namespace : "cortex-plane"
            for (const srv of stdioServers) {
              const scope = srv.agent_scope
              if (scope.length > 0 && !scope.includes(agent.id)) continue

              const conn = srv.connection as { command?: string; args?: string[] }
              if (!conn.command) continue

              mcpClientPool.registerSidecar(srv.id, {
                podName: `agent-${agent.name}`,
                containerName: `mcp-sidecar-${srv.slug}`,
                namespace: ns,
                command: [conn.command, ...(conn.args ?? [])],
              })
            }
          }

          // ── Step 8: Execute task ──
          // If the backend supports per-agent tool registries (HttpLlmBackend),
          // build one that includes custom webhook tools from agent config
          // and MCP tools when a router is available.
          if (
            "createAgentRegistry" in backend &&
            typeof backend.createAgentRegistry === "function"
          ) {
            // Build optional MCP deps from the tool router + task constraints
            const mcpDeps = mcpToolRouter
              ? {
                  mcpRouter: mcpToolRouter,
                  agentId: agent.id,
                  allowedTools: task.constraints.allowedTools,
                  deniedTools: task.constraints.deniedTools,
                  credentialResolver,
                }
              : credentialResolver
                ? {
                    agentId: agent.id,
                    allowedTools: task.constraints.allowedTools,
                    deniedTools: task.constraints.deniedTools,
                    credentialResolver,
                  }
                : undefined

            const agentRegistry = await (
              backend as {
                createAgentRegistry: (c: Record<string, unknown>, m?: unknown) => Promise<unknown>
              }
            ).createAgentRegistry(agent.config ?? {}, mcpDeps)
            handle = await (
              backend as { executeTask: (t: ExecutionTask, r: unknown) => Promise<ExecutionHandle> }
            ).executeTask(task, agentRegistry)
          } else {
            handle = await backend.executeTask(task)
          }

          // ── Step 8b: Register handle in execution registry ──
          if (executionRegistry) {
            executionRegistry.register(jobId, handle)
          }

          // Per-job cost tracker (always created; wired to event emitter + budget below)
          const costTracker = new CostTracker()

          // Resolve cost budget from resource_limits (optional)
          const rawCostBudget = agent.resource_limits.costBudgetUsd
          const costBudgetUsd =
            typeof rawCostBudget === "number" && rawCostBudget > 0 ? rawCostBudget : undefined

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

          // Track LLM turn count (each text event = 1 turn)
          let turnCount = 0

          // Register steer listener so mid-execution steers are consumed
          const unsubSteer = lifecycleManager
            ? lifecycleManager.onSteer(agent.id, (msg: SteerMessage) => {
                turnCount++

                // Apply urgent prefix
                const displayInstruction =
                  msg.priority === "urgent"
                    ? `[URGENT OPERATOR INSTRUCTION] ${msg.instruction}`
                    : msg.instruction

                // Broadcast the steering message as agent output
                if (streamManager) {
                  streamManager.broadcast(agent.id, "agent:output", {
                    agentId: agent.id,
                    timestamp: new Date().toISOString(),
                    output: {
                      type: "text",
                      timestamp: new Date().toISOString(),
                      content: `[STEER] ${displayInstruction}`,
                    },
                  })
                }

                // Acknowledge consumption
                lifecycleManager.acknowledgeSteer(msg.id, turnCount)
              })
            : undefined

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

              // Track LLM turns (text events from the model)
              if (event.type === "text") {
                turnCount++
              }

              // ── Circuit breaker: mid-execution monitoring ──
              if (event.type === "usage") {
                const totalTokens = event.tokenUsage.inputTokens + event.tokenUsage.outputTokens
                if (!agentCB.recordTokenUsage(totalTokens)) {
                  void handle.cancel("token_budget_exceeded")
                }
              }
              if (event.type === "tool_use") {
                if (!agentCB.recordToolCall()) {
                  void handle.cancel("tool_call_rate_exceeded")
                }
              }
              if (event.type === "text") {
                if (!agentCB.recordLlmCall()) {
                  void handle.cancel("llm_call_rate_exceeded")
                }
              }
              if (event.type === "tool_result" && event.isError) {
                agentCB.recordToolError()
              }
              if (event.type === "error") {
                agentCB.recordLlmRetry()
              }

              // ── Event emission + cost tracking ──
              if (event.type === "usage") {
                const { inputTokens, outputTokens, costUsd } = event.tokenUsage
                costTracker.recordLlmCost(inputTokens, outputTokens, costUsd)

                if (eventEmitter) {
                  await eventEmitter
                    .emit({
                      eventType: "llm_call_end",
                      agentId: agent.id,
                      sessionId: job.session_id,
                      jobId,
                      model: task.constraints.model,
                      tokensIn: inputTokens,
                      tokensOut: outputTokens,
                      costUsd,
                      payload: {
                        cacheReadTokens: event.tokenUsage.cacheReadTokens,
                        cacheCreationTokens: event.tokenUsage.cacheCreationTokens,
                      },
                    })
                    .catch(() => {
                      // Non-fatal: event persistence must not block execution.
                    })
                }

                // Cost budget enforcement
                if (costBudgetUsd != null && !costTracker.checkBudget(costBudgetUsd)) {
                  void handle.cancel("cost_budget_exceeded")
                }
              }
              if (event.type === "tool_use") {
                costTracker.recordToolCall()

                if (eventEmitter) {
                  // Fire-and-forget start event; duration tracked by tool_result
                  eventEmitter
                    .emit({
                      eventType: "tool_call_start",
                      agentId: agent.id,
                      sessionId: job.session_id,
                      jobId,
                      toolRef: event.toolName,
                      payload: { input: event.toolInput },
                    })
                    .catch(() => {
                      // Non-fatal
                    })
                }
              }
              if (event.type === "tool_result") {
                if (eventEmitter) {
                  eventEmitter
                    .emit({
                      eventType: "tool_call_end",
                      agentId: agent.id,
                      sessionId: job.session_id,
                      jobId,
                      toolRef: event.toolName,
                      payload: {
                        isError: event.isError,
                        outputLength: event.output.length,
                      },
                    })
                    .catch(() => {
                      // Non-fatal
                    })
                }
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
            unsubSteer?.()
          }

          // ── Step 10: Await final result ──
          const result = await handle.result()

          // ── Step 11: Record outcome for backend circuit breaker ──
          const success = result.status === "completed"
          registry.recordOutcome(providerId, success, result.error?.classification)

          // ── Step 11b: Record outcome for agent circuit breaker ──
          if (success) {
            agentCB.recordJobSuccess()
          } else {
            agentCB.recordJobFailure()
            const postDecision = agentCB.shouldQuarantine()
            if (postDecision.quarantine) {
              rootSpan.addEvent("agent_quarantined_post_execution", {
                "cortex.quarantine.reason": postDecision.reason,
              })
              recordCircuitBreakerTrip(agent.id, postDecision.reason)

              if (lifecycleManager) {
                await lifecycleManager.quarantine(agent.id, postDecision.reason).catch(() => {
                  // best-effort
                })
              }

              await db
                .updateTable("agent")
                .set({ status: "QUARANTINED" })
                .where("id", "=", agent.id)
                .execute()
            }
          }

          rootSpan.setAttribute(CortexAttributes.EXECUTION_STATUS, result.status)
          rootSpan.setAttribute(CortexAttributes.EXECUTION_DURATION_MS, result.durationMs)

          // ── Step 12: Map status and persist result ──
          const jobStatus = mapExecutionStatus(result.status)
          const costSnapshot = costTracker.getSnapshot()

          await db
            .updateTable("job")
            .set({
              status: jobStatus,
              completed_at: new Date(),
              result: executionResultToJson(result),
              tokens_in: costSnapshot.tokensIn,
              tokens_out: costSnapshot.tokensOut,
              cost_usd: String(costSnapshot.costUsd),
              llm_call_count: costSnapshot.llmCalls,
              tool_call_count: costSnapshot.toolCalls,
            })
            .where("id", "=", jobId)
            .where("status", "=", "RUNNING")
            .execute()

          // Update session-level cost accumulators
          if (job.session_id) {
            await db
              .updateTable("session")
              .set({
                total_tokens_in: costSnapshot.tokensIn,
                total_tokens_out: costSnapshot.tokensOut,
                total_cost_usd: String(costSnapshot.costUsd),
              })
              .where("id", "=", job.session_id)
              .execute()
              .catch(() => {
                // Non-fatal: session cost update is best-effort
              })
          }

          // Emit session_end event with accumulated cost
          if (eventEmitter) {
            const sessionEndPayload: Record<string, unknown> = {
              status: jobStatus,
              llmCalls: costSnapshot.llmCalls,
              toolCalls: costSnapshot.toolCalls,
              durationMs: result.durationMs,
            }

            // Tag replay events for tracing
            if (typeof job.payload.replay_source_checkpoint_id === "string") {
              sessionEndPayload.replay_source_checkpoint_id =
                job.payload.replay_source_checkpoint_id
            }

            await eventEmitter
              .emit({
                eventType: "session_end",
                agentId: agent.id,
                sessionId: job.session_id,
                jobId,
                tokensIn: costSnapshot.tokensIn,
                tokensOut: costSnapshot.tokensOut,
                costUsd: costSnapshot.costUsd,
                payload: sessionEndPayload,
              })
              .catch(() => {
                // Non-fatal
              })
          }

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
          if (executionRegistry) {
            executionRegistry.unregister(jobId)
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

        // ── Circuit breaker: record failure in error path ──
        if (agentCB && loadedAgentId) {
          agentCB.recordJobFailure()
          const errDecision = agentCB.shouldQuarantine()
          if (errDecision.quarantine) {
            rootSpan.addEvent("agent_quarantined_on_error", {
              "cortex.quarantine.reason": errDecision.reason,
            })
            recordCircuitBreakerTrip(loadedAgentId, errDecision.reason)

            if (lifecycleManager) {
              await lifecycleManager.quarantine(loadedAgentId, errDecision.reason).catch(() => {
                // best-effort
              })
            }

            await db
              .updateTable("agent")
              .set({ status: "QUARANTINED" })
              .where("id", "=", loadedAgentId)
              .execute()
          }
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

  const task: ExecutionTask = {
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

  // Apply REPLAY modifications when present
  if (
    payload.type === "REPLAY" &&
    typeof payload.replay_modifications === "object" &&
    payload.replay_modifications !== null
  ) {
    const mods = payload.replay_modifications as Record<string, unknown>

    if (typeof mods.model === "string") {
      task.constraints.model = mods.model
    }

    if (typeof mods.systemPromptAppend === "string") {
      task.context.systemPrompt += "\n" + mods.systemPromptAppend
    }

    if (typeof mods.resourceLimits === "object" && mods.resourceLimits !== null) {
      const rl = mods.resourceLimits as Record<string, unknown>
      if (typeof rl.maxTokens === "number") task.constraints.maxTokens = rl.maxTokens
      if (typeof rl.maxTurns === "number") task.constraints.maxTurns = rl.maxTurns
      if (typeof rl.timeoutMs === "number") task.constraints.timeoutMs = rl.timeoutMs
    }
  }

  return task
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
    stdout: result.stdout,
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

// ── Helper: build credential resolver for tool execution ──

function buildCredentialResolver(
  credentialService: CredentialService,
  db: Kysely<Database>,
  agentId: string,
  jobId: string,
): CredentialResolver {
  return async (ref) => {
    try {
      const auditContext = { agentId, jobId, toolName: ref.provider }

      if (ref.credentialClass === "tool_specific") {
        const secret = await credentialService.getToolSecret(ref.provider, auditContext)
        if (!secret) return null

        const key = ref.headerName ?? "Authorization"
        const value = ref.format === "bearer" ? `Bearer ${secret.token}` : secret.token
        return { key, value }
      }

      if (ref.credentialClass === "user_service") {
        const binding = await db
          .selectFrom("agent_credential_binding")
          .innerJoin(
            "provider_credential",
            "provider_credential.id",
            "agent_credential_binding.provider_credential_id",
          )
          .select(["provider_credential.user_account_id", "provider_credential.provider"])
          .where("agent_credential_binding.agent_id", "=", agentId)
          .where("provider_credential.provider", "=", ref.provider)
          .where("provider_credential.credential_class", "=", "user_service")
          .where("provider_credential.status", "=", "active")
          .executeTakeFirst()

        if (!binding) return null

        const result = await credentialService.getAccessToken(
          binding.user_account_id,
          binding.provider,
          auditContext,
        )
        if (!result) return null

        const key = ref.headerName ?? "Authorization"
        const value = ref.format === "bearer" ? `Bearer ${result.token}` : result.token
        return { key, value }
      }

      return null
    } catch {
      // Credential resolution failures fail the tool call, not the job
      return null
    }
  }
}
