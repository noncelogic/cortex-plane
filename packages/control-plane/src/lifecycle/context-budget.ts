/**
 * Context budget enforcement (#266 / #311).
 *
 * The platform computes and enforces max sizes for each context component.
 * Agents cannot exceed these budgets — the platform truncates or rejects
 * oversized components before dispatching a job.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextBudgetConfig {
  maxSystemPromptChars: number
  maxIdentityChars: number
  maxMemoryChars: number
  maxToolDefinitionsChars: number
  maxTotalContextChars: number
  reservedForConversation: number
}

export interface ComponentBudget {
  chars: number
  max: number
  truncated: boolean
}

export interface BudgetResult {
  valid: boolean
  components: Record<string, ComponentBudget>
  totalChars: number
  warnings: string[]
}

export interface ExecutionContext {
  systemPrompt: string
  identity: string
  memory: string
  toolDefinitions: string
  conversationHistory?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxSystemPromptChars: 8_000,
  maxIdentityChars: 4_000,
  maxMemoryChars: 4_000,
  maxToolDefinitionsChars: 16_000,
  maxTotalContextChars: 120_000,
  reservedForConversation: 40_000,
}

const TRUNCATION_MARKER = "\n[TRUNCATED]"

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content to fit within a character budget.
 * Appends a `[TRUNCATED]` marker when content is cut.
 */
export function truncateComponent(
  content: string,
  maxChars: number,
): { result: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { result: content, truncated: false }
  }
  const cutoff = maxChars - TRUNCATION_MARKER.length
  if (cutoff <= 0) {
    return { result: TRUNCATION_MARKER.slice(0, maxChars), truncated: true }
  }
  return { result: content.slice(0, cutoff) + TRUNCATION_MARKER, truncated: true }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate all context components against the budget.
 *
 * Returns a `BudgetResult` with per-component details, the total character
 * count, and any warnings. `valid` is `false` when the assembled context
 * exceeds `maxTotalContextChars` (even after per-component truncation).
 */
export function validateContextBudget(
  context: ExecutionContext,
  config: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET,
): BudgetResult {
  const warnings: string[] = []
  const components: Record<string, ComponentBudget> = {}

  // Validate each component against its individual budget
  const entries: Array<{ key: string; content: string; max: number }> = [
    { key: "systemPrompt", content: context.systemPrompt, max: config.maxSystemPromptChars },
    { key: "identity", content: context.identity, max: config.maxIdentityChars },
    { key: "memory", content: context.memory, max: config.maxMemoryChars },
    {
      key: "toolDefinitions",
      content: context.toolDefinitions,
      max: config.maxToolDefinitionsChars,
    },
  ]

  for (const { key, content, max } of entries) {
    const chars = content.length
    const truncated = chars > max
    if (truncated) {
      const pctLost = Math.round(((chars - max) / chars) * 100)
      warnings.push(`${key} exceeds ${max} char limit (${chars} chars, ${pctLost}% truncated)`)
    }
    components[key] = { chars: Math.min(chars, max), max, truncated }
  }

  // Conversation history (not truncated by us, just measured)
  const conversationChars = context.conversationHistory?.length ?? 0
  components["conversationHistory"] = {
    chars: conversationChars,
    max: config.reservedForConversation,
    truncated: false,
  }

  // Compute total from post-truncation sizes
  const totalChars = Object.values(components).reduce((sum, c) => sum + c.chars, 0)
  const valid = totalChars <= config.maxTotalContextChars

  if (!valid) {
    warnings.push(
      `Total context (${totalChars} chars) exceeds ${config.maxTotalContextChars} char limit`,
    )
  }

  return { valid, components, totalChars, warnings }
}
