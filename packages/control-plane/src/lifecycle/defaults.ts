/**
 * Shared defaults for the agent lifecycle module.
 */

import type { ContextBudgetConfig } from "./context-budget.js"

/**
 * System-wide default context budget.
 *
 * These limits keep assembled execution contexts within the token window
 * of the target LLM while reserving space for the conversation itself.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxSystemPromptChars: 8_000,
  maxIdentityChars: 4_000,
  maxMemoryChars: 4_000,
  maxToolDefinitionsChars: 16_000,
  maxTotalContextChars: 120_000,
  reservedForConversation: 40_000,
}
