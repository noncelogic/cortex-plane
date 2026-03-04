/**
 * AgentCircuitBreaker — per-agent circuit breaker for job execution.
 *
 * Tracks consecutive job failures, per-job token budget, and per-minute
 * tool/LLM call rate limits.  Used by agent-execute to decide whether
 * an agent should be quarantined or a running job cancelled.
 *
 * Unlike the provider-level CircuitBreaker (packages/shared), this
 * operates at the *agent* granularity and is driven by job outcomes
 * rather than backend call outcomes.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentCircuitBreakerConfig {
  /** Consecutive failed jobs before shouldQuarantine() returns true. */
  maxConsecutiveFailures: number
  /** Max tokens (input + output) per job. null = unlimited. */
  tokenBudget: number | null
  /** Max tool_use events per minute. null = unlimited. */
  maxToolCallsPerMinute: number | null
  /** Max LLM response events per minute. null = unlimited. */
  maxLlmCallsPerMinute: number | null
}

export const DEFAULT_AGENT_CB_CONFIG: AgentCircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  tokenBudget: null,
  maxToolCallsPerMinute: null,
  maxLlmCallsPerMinute: null,
}

// ---------------------------------------------------------------------------
// Rate-limit sliding window helper
// ---------------------------------------------------------------------------

class SlidingWindowCounter {
  private readonly timestamps: number[] = []
  private readonly windowMs: number

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  record(now: number = Date.now()): number {
    this.timestamps.push(now)
    this.prune(now)
    return this.timestamps.length
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift()
    }
  }
}

// ---------------------------------------------------------------------------
// AgentCircuitBreaker
// ---------------------------------------------------------------------------

export class AgentCircuitBreaker {
  private consecutiveFailures = 0
  private cumulativeTokens = 0
  private readonly config: AgentCircuitBreakerConfig
  private readonly toolCallWindow: SlidingWindowCounter | null
  private readonly llmCallWindow: SlidingWindowCounter | null

  constructor(config?: Partial<AgentCircuitBreakerConfig>) {
    this.config = { ...DEFAULT_AGENT_CB_CONFIG, ...config }
    this.toolCallWindow =
      this.config.maxToolCallsPerMinute != null ? new SlidingWindowCounter(60_000) : null
    this.llmCallWindow =
      this.config.maxLlmCallsPerMinute != null ? new SlidingWindowCounter(60_000) : null
  }

  // ── Job-level signals ──

  /**
   * Check whether this agent should be quarantined based on its
   * consecutive failure count.
   */
  shouldQuarantine(): boolean {
    return this.consecutiveFailures >= this.config.maxConsecutiveFailures
  }

  /** Record a successful job. Resets the failure counter. */
  recordJobSuccess(): void {
    this.consecutiveFailures = 0
  }

  /** Record a failed job. Increments the consecutive failure counter. */
  recordJobFailure(): void {
    this.consecutiveFailures++
  }

  // ── Token budget ──

  /**
   * Record token usage from an OutputUsageEvent.
   * @returns `true` if within budget, `false` if budget exceeded.
   */
  recordTokenUsage(usage: { inputTokens: number; outputTokens: number }): boolean {
    this.cumulativeTokens += usage.inputTokens + usage.outputTokens
    if (this.config.tokenBudget != null && this.cumulativeTokens > this.config.tokenBudget) {
      return false
    }
    return true
  }

  // ── Rate limits ──

  /**
   * Record a tool_use event.
   * @returns `true` if within rate limit, `false` if exceeded.
   */
  recordToolCall(): boolean {
    if (!this.toolCallWindow || this.config.maxToolCallsPerMinute == null) return true
    const count = this.toolCallWindow.record()
    return count <= this.config.maxToolCallsPerMinute
  }

  /**
   * Record an LLM response (text) event.
   * @returns `true` if within rate limit, `false` if exceeded.
   */
  recordLlmCall(): boolean {
    if (!this.llmCallWindow || this.config.maxLlmCallsPerMinute == null) return true
    const count = this.llmCallWindow.record()
    return count <= this.config.maxLlmCallsPerMinute
  }

  // ── Introspection ──

  get failureCount(): number {
    return this.consecutiveFailures
  }

  get totalTokensUsed(): number {
    return this.cumulativeTokens
  }
}
