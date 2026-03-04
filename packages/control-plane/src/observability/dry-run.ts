/**
 * Dry Run — simulate an agent turn without tool execution
 *
 * Builds a full execution context (system prompt, tool definitions,
 * conversation history) and runs one LLM turn. Tool calls requested
 * by the LLM are collected but never executed for real — stubs return
 * a deterministic placeholder instead.
 *
 * No side effects: no session_message writes, no checkpoint updates,
 * no job creation.
 */

import type { ExecutionTask, OutputEvent, TokenUsage } from "@cortex/shared/backends"
import type { Kysely } from "kysely"

import { HttpLlmBackend, type McpDeps } from "../backends/http-llm.js"
import { type ToolDefinition, type ToolRegistry } from "../backends/tool-executor.js"
import { loadConversationHistory } from "../channels/message-dispatch.js"
import type { Database } from "../db/types.js"
import type { McpToolRouter } from "../mcp/tool-router.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DryRunInput {
  message: string
  sessionId?: string
  maxTurns?: number
}

export interface PlannedAction {
  type: "tool_call"
  toolRef: string
  input: Record<string, unknown>
}

export interface DryRunResult {
  plannedActions: PlannedAction[]
  agentResponse: string
  tokensUsed: { in: number; out: number }
  estimatedCostUsd: number
}

export interface DryRunDeps {
  db: Kysely<Database>
  mcpToolRouter?: McpToolRouter
}

// ---------------------------------------------------------------------------
// Cost estimation (rough per-token pricing for common models)
// ---------------------------------------------------------------------------

const COST_PER_1K_INPUT = 0.003
const COST_PER_1K_OUTPUT = 0.015

function estimateCost(usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1000) * COST_PER_1K_INPUT +
    (usage.outputTokens / 1000) * COST_PER_1K_OUTPUT
  )
}

// ---------------------------------------------------------------------------
// Dry-run stub factory
// ---------------------------------------------------------------------------

/**
 * Wrap every tool in the registry so that execute() returns a
 * deterministic stub instead of performing real work.
 */
export function stubToolRegistry(registry: ToolRegistry): ToolRegistry {
  // The ToolRegistry class doesn't expose iteration, so we create a
  // thin proxy that intercepts execute() calls.  We do this by
  // replacing the `execute` method on the registry itself.
  const originalExecute = registry.execute.bind(registry)

  registry.execute = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> => {
    // Verify the tool exists (so "unknown tool" errors still surface)
    const tool = registry.get(name)
    if (!tool) {
      return originalExecute(name, input)
    }

    return {
      output: `[DRY RUN] Tool ${name} would be called with: ${JSON.stringify(input)}`,
      isError: false,
    }
  }

  return registry
}

// ---------------------------------------------------------------------------
// Core dry-run executor
// ---------------------------------------------------------------------------

export async function executeDryRun(
  agentId: string,
  input: DryRunInput,
  deps: DryRunDeps,
): Promise<DryRunResult> {
  const { db, mcpToolRouter } = deps

  // ── Load agent ──
  const agent = await db
    .selectFrom("agent")
    .selectAll()
    .where("id", "=", agentId)
    .executeTakeFirst()

  if (!agent) {
    throw new DryRunError("not_found", "Agent not found")
  }

  if (agent.status !== "ACTIVE") {
    throw new DryRunError("conflict", `Agent is ${agent.status}, must be ACTIVE`)
  }

  // ── Load conversation history (if sessionId provided) ──
  let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = []
  if (input.sessionId) {
    const session = await db
      .selectFrom("session")
      .select("id")
      .where("id", "=", input.sessionId)
      .where("agent_id", "=", agentId)
      .where("status", "=", "active")
      .executeTakeFirst()

    if (session) {
      conversationHistory = await loadConversationHistory(db, session.id)
    }
  }

  // ── Build execution task ──
  const agentConfig = agent.model_config
  const skillConfig = agent.skill_config
  const resourceLimits = agent.resource_limits

  const allowedTools: string[] = Array.isArray(skillConfig.allowedTools)
    ? (skillConfig.allowedTools as string[])
    : []
  const deniedTools: string[] = Array.isArray(skillConfig.deniedTools)
    ? (skillConfig.deniedTools as string[])
    : []

  const task: ExecutionTask = {
    id: `dry-run-${Date.now()}`,
    jobId: `dry-run-${Date.now()}`,
    agentId: agent.id,
    instruction: {
      prompt: input.message,
      goalType: "research",
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
    },
    context: {
      workspacePath:
        typeof agentConfig.workspacePath === "string" ? agentConfig.workspacePath : "/workspace",
      systemPrompt:
        typeof agentConfig.systemPrompt === "string"
          ? agentConfig.systemPrompt
          : `You are ${agent.name}, a ${agent.role} agent.${agent.description ? ` ${agent.description}` : ""}`,
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 120_000,
      maxTokens: typeof resourceLimits.maxTokens === "number" ? resourceLimits.maxTokens : 200_000,
      model:
        typeof agentConfig.model === "string" ? agentConfig.model : "claude-sonnet-4-5-20250514",
      allowedTools,
      deniedTools,
      maxTurns: input.maxTurns ?? 1,
      networkAccess: false,
      shellAccess: false,
    },
  }

  // ── Build tool registry with stubs ──
  const backend = new HttpLlmBackend()
  await backend.start({
    provider: (agentConfig.provider as string) ?? process.env.LLM_PROVIDER ?? "anthropic",
    apiKey: (agentConfig.apiKey as string) ?? process.env.LLM_API_KEY,
    model: task.constraints.model,
    baseUrl: (agentConfig.baseUrl as string) ?? process.env.LLM_BASE_URL,
  })

  try {
    const mcpDeps: McpDeps | undefined = mcpToolRouter
      ? {
          mcpRouter: mcpToolRouter,
          agentId: agent.id,
          allowedTools,
          deniedTools,
        }
      : undefined

    const registry = await backend.createAgentRegistry(agent.config ?? {}, mcpDeps)
    const stubbedRegistry = stubToolRegistry(registry)

    // ── Execute one LLM turn ──
    const handle = await backend.executeTask(task, stubbedRegistry)

    const plannedActions: PlannedAction[] = []
    let agentResponse = ""
    let tokensUsed: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }

    for await (const event of handle.events()) {
      switch (event.type) {
        case "text":
          agentResponse += event.content
          break
        case "tool_use":
          plannedActions.push({
            type: "tool_call",
            toolRef: event.toolName,
            input: event.toolInput,
          })
          break
        case "usage":
          tokensUsed = event.tokenUsage
          break
      }
    }

    return {
      plannedActions,
      agentResponse,
      tokensUsed: { in: tokensUsed.inputTokens, out: tokensUsed.outputTokens },
      estimatedCostUsd: estimateCost(tokensUsed),
    }
  } finally {
    await backend.stop()
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class DryRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DryRunError"
  }
}
