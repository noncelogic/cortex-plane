/**
 * Circuit Breaker
 *
 * Per-provider sliding-window circuit breaker with three states:
 *   CLOSED  (healthy)  → requests pass through normally
 *   OPEN    (tripped)  → requests immediately fail, no calls to backend
 *   HALF_OPEN (probing) → limited canary traffic to test recovery
 *
 * See: docs/issues/098-multi-provider-routing.md
 */

import { trace } from "@opentelemetry/api"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN"

export interface CircuitBreakerConfig {
  /** Number of failures in window to trip the breaker. */
  failureThreshold: number
  /** Sliding window duration (ms). */
  windowMs: number
  /** How long to stay OPEN before transitioning to HALF_OPEN (ms). */
  openDurationMs: number
  /** Max concurrent requests allowed in HALF_OPEN state. */
  halfOpenMaxAttempts: number
  /** Consecutive successes in HALF_OPEN needed to close the breaker. */
  successThresholdToClose: number
}

export interface CircuitStats {
  state: CircuitState
  windowFailureCount: number
  windowTotalCalls: number
  consecutiveHalfOpenSuccesses: number
  lastStateChange: string
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  openDurationMs: 30_000,
  halfOpenMaxAttempts: 1,
  successThresholdToClose: 3,
}

// ──────────────────────────────────────────────────
// Circuit Breaker
// ──────────────────────────────────────────────────

interface TimestampedFailure {
  timestamp: number
  classification: string
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED"
  private failures: TimestampedFailure[] = []
  private successes: number[] = []
  private lastStateChange: number
  private openedAt: number | null = null
  private halfOpenActive = 0
  private consecutiveHalfOpenSuccesses = 0
  private readonly config: CircuitBreakerConfig
  private readonly now: () => number

  constructor(config?: Partial<CircuitBreakerConfig>, now?: () => number) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.now = now ?? Date.now
    this.lastStateChange = this.now()
  }

  canExecute(): boolean {
    this.maybeTransition()

    switch (this.state) {
      case "CLOSED":
        return true
      case "OPEN":
        return false
      case "HALF_OPEN":
        return this.halfOpenActive < this.config.halfOpenMaxAttempts
    }
  }

  recordSuccess(): void {
    this.maybeTransition()
    const now = this.now()
    this.successes.push(now)

    if (this.state === "HALF_OPEN") {
      this.halfOpenActive = Math.max(0, this.halfOpenActive - 1)
      this.consecutiveHalfOpenSuccesses++

      if (this.consecutiveHalfOpenSuccesses >= this.config.successThresholdToClose) {
        this.transitionTo("CLOSED")
      }
    }
  }

  recordFailure(classification: string): void {
    this.maybeTransition()
    const now = this.now()

    // Only count transient/retryable failures for tripping the breaker
    if (classification !== "transient" && classification !== "resource") {
      return
    }

    this.failures.push({ timestamp: now, classification })

    if (this.state === "HALF_OPEN") {
      this.halfOpenActive = Math.max(0, this.halfOpenActive - 1)
      this.consecutiveHalfOpenSuccesses = 0
      this.transitionTo("OPEN")
      return
    }

    if (this.state === "CLOSED") {
      this.pruneWindow()
      if (this.failures.length >= this.config.failureThreshold) {
        this.transitionTo("OPEN")
      }
    }
  }

  getState(): CircuitState {
    this.maybeTransition()
    return this.state
  }

  getStats(): CircuitStats {
    this.maybeTransition()
    this.pruneWindow()

    return {
      state: this.state,
      windowFailureCount: this.failures.length,
      windowTotalCalls:
        this.failures.length +
        this.successes.filter((t) => t > this.now() - this.config.windowMs).length,
      consecutiveHalfOpenSuccesses: this.consecutiveHalfOpenSuccesses,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
    }
  }

  /** Track that a half-open request has been dispatched (occupies a slot). */
  acquireHalfOpenSlot(): void {
    this.maybeTransition()
    if (this.state === "HALF_OPEN") {
      this.halfOpenActive++
    }
  }

  private maybeTransition(): void {
    if (this.state === "OPEN" && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt
      if (elapsed >= this.config.openDurationMs) {
        this.transitionTo("HALF_OPEN")
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const previousState = this.state
    this.state = newState
    this.lastStateChange = this.now()

    // Record state transition as a span event on the active span (if any)
    const span = trace.getActiveSpan()
    if (span) {
      span.addEvent("circuit_breaker.state_change", {
        "cortex.circuit.previous_state": previousState,
        "cortex.circuit.new_state": newState,
      })
    }

    if (newState === "OPEN") {
      this.openedAt = this.now()
    } else if (newState === "CLOSED") {
      this.openedAt = null
      this.failures = []
      this.successes = []
      this.halfOpenActive = 0
      this.consecutiveHalfOpenSuccesses = 0
    } else if (newState === "HALF_OPEN") {
      this.halfOpenActive = 0
      this.consecutiveHalfOpenSuccesses = 0
    }
  }

  private pruneWindow(): void {
    const cutoff = this.now() - this.config.windowMs
    this.failures = this.failures.filter((f) => f.timestamp > cutoff)
    this.successes = this.successes.filter((t) => t > cutoff)
  }
}
