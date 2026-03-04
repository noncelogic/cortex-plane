/**
 * Context budget enforcement.
 *
 * Validates and optionally truncates context components (system prompt,
 * identity, memories, tool definitions) so the assembled execution context
 * stays within the target LLM's token window.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextBudgetConfig {
  /** Maximum characters for the system prompt. */
  maxSystemPromptChars: number
  /** Maximum characters for agent identity (name, role, description). */
  maxIdentityChars: number
  /** Maximum characters for memory / Qdrant context. */
  maxMemoryChars: number
  /** Maximum characters for serialised tool definitions. */
  maxToolDefinitionsChars: number
  /** Hard cap on total assembled context characters. */
  maxTotalContextChars: number
  /** Characters reserved for multi-turn conversation history. */
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

// ---------------------------------------------------------------------------
// Context shape passed to validation
// ---------------------------------------------------------------------------

export interface ContextComponents {
  systemPrompt?: string
  identity?: string
  memories?: string
  toolDefinitions?: string
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

const TRUNCATED_MARKER = "[TRUNCATED]"

/**
 * Truncate `content` to at most `maxChars` characters.
 * When truncation occurs a `[TRUNCATED]` marker is appended within the limit.
 */
export function truncateComponent(
  content: string,
  maxChars: number,
): { result: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { result: content, truncated: false }
  }

  const trimTo = maxChars - TRUNCATED_MARKER.length
  const result =
    trimTo > 0 ? content.slice(0, trimTo) + TRUNCATED_MARKER : TRUNCATED_MARKER.slice(0, maxChars)
  return { result, truncated: true }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate (and optionally report on) every context component against the
 * supplied budget configuration.
 *
 * Individual components that exceed their budget are flagged with
 * `truncated: true` in the result — the caller is responsible for applying
 * `truncateComponent()` when it wants to enforce the limit.
 *
 * If the **total** assembled context exceeds `maxTotalContextChars` the
 * result's `valid` field is set to `false`.
 */
export function validateContextBudget(
  context: ContextComponents,
  config: ContextBudgetConfig,
): BudgetResult {
  const warnings: string[] = []

  const componentEntries: Array<[string, string, number]> = [
    ["systemPrompt", context.systemPrompt ?? "", config.maxSystemPromptChars],
    ["identity", context.identity ?? "", config.maxIdentityChars],
    ["memories", context.memories ?? "", config.maxMemoryChars],
    ["toolDefinitions", context.toolDefinitions ?? "", config.maxToolDefinitionsChars],
  ]

  const components: Record<string, ComponentBudget> = {}
  let totalChars = 0

  for (const [name, value, max] of componentEntries) {
    const chars = value.length
    const truncated = chars > max

    components[name] = { chars, max, truncated }
    totalChars += chars

    if (truncated) {
      warnings.push(`${name} exceeds budget: ${chars} chars > ${max} max (will be truncated)`)
    }
  }

  // Account for reserved conversation space when checking the total
  const effectiveMax = config.maxTotalContextChars - config.reservedForConversation
  const valid = totalChars <= effectiveMax

  if (!valid) {
    warnings.push(
      `Total context (${totalChars} chars) exceeds budget (${effectiveMax} usable of ${config.maxTotalContextChars} total, ${config.reservedForConversation} reserved for conversation)`,
    )
  }

  return { valid, components, totalChars, warnings }
}
