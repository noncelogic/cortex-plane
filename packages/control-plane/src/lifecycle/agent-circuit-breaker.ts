/**
 * Agent-level circuit breaker (#266 / #313).
 *
 * Monitors an agent's own behavior — independent of backend provider
 * circuit breakers. Tracks consecutive job failures, per-job tool/LLM
 * errors, token budgets, and rate limits to decide when an agent should
 * be quarantined or a job aborted.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCircuitBreakerConfig {
  maxConsecutiveFailures: number
  maxToolErrorsPerJob: number
  maxLlmRetriesPerJob: number
  tokenBudgetPerJob: number
  tokenBudgetPerSession: number
  toolCallRateLimit: { maxCalls: number; windowSeconds: number }
  llmCallRateLimit: { maxCalls: number; windowSeconds: number }
}

export interface AgentCircuitBreakerState {
  consecutiveJobFailures: number
  currentJobToolErrors: number
  currentJobLlmRetries: number
  currentJobTokensUsed: number
  currentSessionTokensUsed: number
  toolCallTimestamps: number[]
  llmCallTimestamps: number[]
  tripped: boolean
  tripReason: string | null
}

export interface QuarantineDecision {
  quarantine: boolean
  reason: string
}

export interface AbortDecision {
  abort: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// Defaults (canonical source: defaults.ts)
// ---------------------------------------------------------------------------

export { DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG } from "./defaults.js"
import { DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG } from "./defaults.js"

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AgentCircuitBreaker {
  readonly agentId: string
  private readonly config: AgentCircuitBreakerConfig
  private state: AgentCircuitBreakerState

  constructor(agentId: string, config?: Partial<AgentCircuitBreakerConfig>) {
    this.agentId = agentId
    this.config = { ...DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.state = this.initialState()
  }

  // -------------------------------------------------------------------------
  // Recording methods
  // -------------------------------------------------------------------------

  /** Record a successful job completion. Resets consecutive failure count. */
  recordJobSuccess(): void {
    this.state.consecutiveJobFailures = 0
    this.state.currentJobToolErrors = 0
    this.state.currentJobLlmRetries = 0
    this.state.currentJobTokensUsed = 0
  }

  /** Record a job failure. Increments consecutive failure count. */
  recordJobFailure(): void {
    this.state.consecutiveJobFailures++
    this.state.currentJobToolErrors = 0
    this.state.currentJobLlmRetries = 0
    this.state.currentJobTokensUsed = 0
  }

  /**
   * Record a tool call. Returns `false` if the sliding-window rate limit
   * has been exceeded.
   */
  recordToolCall(now: number = Date.now()): boolean {
    this.pruneWindow(
      this.state.toolCallTimestamps,
      this.config.toolCallRateLimit.windowSeconds,
      now,
    )
    if (this.state.toolCallTimestamps.length >= this.config.toolCallRateLimit.maxCalls) {
      return false
    }
    this.state.toolCallTimestamps.push(now)
    return true
  }

  /**
   * Record an LLM call. Returns `false` if the sliding-window rate limit
   * has been exceeded.
   */
  recordLlmCall(now: number = Date.now()): boolean {
    this.pruneWindow(this.state.llmCallTimestamps, this.config.llmCallRateLimit.windowSeconds, now)
    if (this.state.llmCallTimestamps.length >= this.config.llmCallRateLimit.maxCalls) {
      return false
    }
    this.state.llmCallTimestamps.push(now)
    return true
  }

  /**
   * Record token usage. Returns `false` if either per-job or per-session
   * token budget has been exceeded.
   */
  recordTokenUsage(tokens: number): boolean {
    this.state.currentJobTokensUsed += tokens
    this.state.currentSessionTokensUsed += tokens
    return (
      this.state.currentJobTokensUsed <= this.config.tokenBudgetPerJob &&
      this.state.currentSessionTokensUsed <= this.config.tokenBudgetPerSession
    )
  }

  /** Record a tool error in the current job. */
  recordToolError(): void {
    this.state.currentJobToolErrors++
  }

  /** Record an LLM retry in the current job. */
  recordLlmRetry(): void {
    this.state.currentJobLlmRetries++
  }

  // -------------------------------------------------------------------------
  // Decision methods
  // -------------------------------------------------------------------------

  /** Check if the agent should be quarantined (consecutive job failures). */
  shouldQuarantine(): QuarantineDecision {
    if (this.state.consecutiveJobFailures >= this.config.maxConsecutiveFailures) {
      const reason = `${this.state.consecutiveJobFailures} consecutive job failures (threshold: ${this.config.maxConsecutiveFailures})`
      this.trip(reason)
      return { quarantine: true, reason }
    }
    return { quarantine: false, reason: "" }
  }

  /** Check if the current job should be aborted. */
  shouldAbortJob(): AbortDecision {
    if (this.state.currentJobToolErrors >= this.config.maxToolErrorsPerJob) {
      return {
        abort: true,
        reason: `tool_errors: ${this.state.currentJobToolErrors} errors (threshold: ${this.config.maxToolErrorsPerJob})`,
      }
    }
    if (this.state.currentJobLlmRetries >= this.config.maxLlmRetriesPerJob) {
      return {
        abort: true,
        reason: `llm_retries: ${this.state.currentJobLlmRetries} retries (threshold: ${this.config.maxLlmRetriesPerJob})`,
      }
    }
    if (this.state.currentJobTokensUsed > this.config.tokenBudgetPerJob) {
      return {
        abort: true,
        reason: `token_budget: ${this.state.currentJobTokensUsed} tokens used (budget: ${this.config.tokenBudgetPerJob})`,
      }
    }
    if (this.state.currentSessionTokensUsed > this.config.tokenBudgetPerSession) {
      return {
        abort: true,
        reason: `session_token_budget: ${this.state.currentSessionTokensUsed} tokens used (budget: ${this.config.tokenBudgetPerSession})`,
      }
    }
    return { abort: false, reason: "" }
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /** Reset all counters (e.g. on operator release from quarantine). */
  reset(): void {
    Object.assign(this.state, this.initialState())
  }

  /** Whether the circuit breaker has been tripped. */
  get tripped(): boolean {
    return this.state.tripped
  }

  /** The reason the circuit breaker tripped, or `null`. */
  get tripReason(): string | null {
    return this.state.tripReason
  }

  /** Snapshot of current internal state (for health API / debugging). */
  getState(): Readonly<AgentCircuitBreakerState> {
    return { ...this.state }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private trip(reason: string): void {
    this.state.tripped = true
    this.state.tripReason = reason
  }

  private pruneWindow(timestamps: number[], windowSeconds: number, now: number): void {
    const cutoff = now - windowSeconds * 1000
    // Remove timestamps outside the window. Timestamps are in order so we
    // can find the first valid index and splice.
    let firstValid = 0
    while (firstValid < timestamps.length && timestamps[firstValid]! < cutoff) {
      firstValid++
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid)
    }
  }

  private initialState(): AgentCircuitBreakerState {
    return {
      consecutiveJobFailures: 0,
      currentJobToolErrors: 0,
      currentJobLlmRetries: 0,
      currentJobTokensUsed: 0,
      currentSessionTokensUsed: 0,
      toolCallTimestamps: [],
      llmCallTimestamps: [],
      tripped: false,
      tripReason: null,
    }
  }
}
