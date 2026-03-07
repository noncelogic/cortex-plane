/**
 * CostTracker — accumulates LLM cost and token usage within a single job
 * execution. Provides budget enforcement: when cumulative cost exceeds the
 * configured budget, `checkBudget()` returns `false`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostSnapshot {
  tokensIn: number
  tokensOut: number
  costUsd: number
  llmCalls: number
  toolCalls: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CostTracker {
  private tokensIn = 0
  private tokensOut = 0
  private costUsd = 0
  private llmCalls = 0
  private toolCalls = 0

  /**
   * Record an LLM call's cost and token usage.
   */
  recordLlmCost(tokensIn: number, tokensOut: number, costUsd: number): void {
    this.tokensIn += tokensIn
    this.tokensOut += tokensOut
    this.costUsd += costUsd
    this.llmCalls++
  }

  /**
   * Record a tool call (count only — tool calls don't have direct cost).
   */
  recordToolCall(): void {
    this.toolCalls++
  }

  /**
   * Check whether the accumulated cost is within the given budget.
   * Returns `true` if within budget, `false` if exceeded.
   */
  checkBudget(budgetUsd: number): boolean {
    return this.costUsd <= budgetUsd
  }

  /**
   * Return a snapshot of the current accumulated usage.
   */
  getSnapshot(): CostSnapshot {
    return {
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costUsd: this.costUsd,
      llmCalls: this.llmCalls,
      toolCalls: this.toolCalls,
    }
  }

  /**
   * Total accumulated cost in USD.
   */
  getTotalCost(): number {
    return this.costUsd
  }
}
