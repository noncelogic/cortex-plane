/**
 * Model pricing table and cost estimation.
 *
 * Prices are in USD per million tokens. When a model is not found in the
 * table, {@link DEFAULT_PRICING} is used so that cost is never zero for
 * non-zero token counts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMToken: number
  /** USD per million output tokens. */
  outputPerMToken: number
  /** USD per million cache-read tokens (optional). */
  cacheReadPerMToken?: number
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

export const DEFAULT_PRICING: ModelPricing = {
  inputPerMToken: 3.0,
  outputPerMToken: 15.0,
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.x
  "claude-opus-4-6": {
    inputPerMToken: 15.0,
    outputPerMToken: 75.0,
    cacheReadPerMToken: 1.5,
  },
  "claude-sonnet-4-6": {
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheReadPerMToken: 0.3,
  },
  "claude-haiku-4-5": {
    inputPerMToken: 0.8,
    outputPerMToken: 4.0,
    cacheReadPerMToken: 0.08,
  },

  // GPT-4o family
  "gpt-4o": {
    inputPerMToken: 2.5,
    outputPerMToken: 10.0,
  },
  "gpt-4o-mini": {
    inputPerMToken: 0.15,
    outputPerMToken: 0.6,
  },
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of an LLM call in USD.
 *
 * Uses model-specific pricing when available, otherwise falls back to
 * {@link DEFAULT_PRICING}. Returns a positive number for non-zero token
 * counts; never returns zero for unknown models.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheReadTokens?: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING

  let cost =
    (tokensIn / 1_000_000) * pricing.inputPerMToken +
    (tokensOut / 1_000_000) * pricing.outputPerMToken

  if (cacheReadTokens && pricing.cacheReadPerMToken) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMToken
  }

  return cost
}
