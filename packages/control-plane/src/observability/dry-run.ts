/**
 * Dry Run — simulate an agent turn without real tool execution.
 *
 * Builds the execution context as normal (system prompt, tool definitions,
 * optional conversation history), but replaces every tool `execute()`
 * function with a stub that returns a synthetic "[DRY RUN]" message.
 *
 * The LLM sees real tool definitions and may request tool calls. Those
 * calls are captured as `plannedActions` without side effects. No session
 * messages, checkpoints, or agent state changes are persisted.
 */

import type { TokenUsage } from "@cortex/shared/backends"
import type { Kysely } from "kysely"

import type { ToolDefinition, ToolRegistry } from "../backends/tool-executor.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stub replacement
// ---------------------------------------------------------------------------

/**
 * Create a new ToolRegistry whose tool definitions are clones of the
 * originals, but with every `execute()` replaced by a dry-run stub.
 *
 * Planned actions are pushed into the provided `actions` array as a
 * side-channel so the caller can inspect them after the LLM turn.
 */
export function stubTools(
  registry: ToolRegistry,
  allowedTools: string[],
  deniedTools: string[],
  actions: PlannedAction[],
): ToolDefinition[] {
  const originals = registry.resolve(allowedTools, deniedTools)

  return originals.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: (input: Record<string, unknown>) => {
      actions.push({ type: "tool_call", toolRef: tool.name, input })
      return Promise.resolve(
        `[DRY RUN] Tool ${tool.name} would be called with: ${JSON.stringify(input)}`,
      )
    },
  }))
}

// ---------------------------------------------------------------------------
// Conversation context loader
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  role: "user" | "assistant"
  content: string
}

/**
 * Load existing conversation context from the session_message table.
 * Returns an empty array when no sessionId is provided.
 */
export async function loadConversationContext(
  db: Kysely<Database>,
  sessionId?: string,
): Promise<ConversationTurn[]> {
  if (!sessionId) return []

  const rows = await db
    .selectFrom("session_message")
    .select(["role", "content"])
    .where("session_id", "=", sessionId)
    .orderBy("created_at", "asc")
    .execute()

  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
  }))
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Rough per-1K-token pricing for cost estimation. */
const DEFAULT_INPUT_COST_PER_1K = 0.003
const DEFAULT_OUTPUT_COST_PER_1K = 0.015

export function estimateCost(usage: TokenUsage): number {
  const inCost = (usage.inputTokens / 1000) * DEFAULT_INPUT_COST_PER_1K
  const outCost = (usage.outputTokens / 1000) * DEFAULT_OUTPUT_COST_PER_1K
  return parseFloat((inCost + outCost).toFixed(6))
}
