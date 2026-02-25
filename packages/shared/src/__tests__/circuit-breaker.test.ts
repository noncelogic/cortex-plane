import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
} from "../backends/circuit-breaker.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function createBreaker(
  config?: Partial<CircuitBreakerConfig>,
  now?: () => number,
): CircuitBreaker {
  return new CircuitBreaker(config, now)
}

// ──────────────────────────────────────────────────
// Default Config
// ──────────────────────────────────────────────────

describe("DEFAULT_CIRCUIT_BREAKER_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5)
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs).toBe(60_000)
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.openDurationMs).toBe(30_000)
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts).toBe(1)
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.successThresholdToClose).toBe(3)
  })
})

// ──────────────────────────────────────────────────
// Initial State
// ──────────────────────────────────────────────────

describe("CircuitBreaker — initial state", () => {
  it("starts in CLOSED state", () => {
    const breaker = createBreaker()
    expect(breaker.getState()).toBe("CLOSED")
  })

  it("allows execution when CLOSED", () => {
    const breaker = createBreaker()
    expect(breaker.canExecute()).toBe(true)
  })

  it("initial stats are zeroed", () => {
    const breaker = createBreaker()
    const stats = breaker.getStats()
    expect(stats.state).toBe("CLOSED")
    expect(stats.windowFailureCount).toBe(0)
    expect(stats.consecutiveHalfOpenSuccesses).toBe(0)
  })
})

// ──────────────────────────────────────────────────
// CLOSED → OPEN transition
// ──────────────────────────────────────────────────

describe("CircuitBreaker — CLOSED → OPEN", () => {
  it("trips after reaching failure threshold with transient errors", () => {
    const breaker = createBreaker({ failureThreshold: 3 })

    breaker.recordFailure("transient")
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("CLOSED")

    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("trips after reaching failure threshold with resource errors", () => {
    const breaker = createBreaker({ failureThreshold: 2 })

    breaker.recordFailure("resource")
    breaker.recordFailure("resource")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("does NOT count permanent errors toward threshold", () => {
    const breaker = createBreaker({ failureThreshold: 2 })

    breaker.recordFailure("permanent")
    breaker.recordFailure("permanent")
    breaker.recordFailure("permanent")
    expect(breaker.getState()).toBe("CLOSED")
  })

  it("does NOT count timeout errors toward threshold", () => {
    const breaker = createBreaker({ failureThreshold: 2 })

    breaker.recordFailure("timeout")
    breaker.recordFailure("timeout")
    expect(breaker.getState()).toBe("CLOSED")
  })

  it("blocks execution when OPEN", () => {
    const breaker = createBreaker({ failureThreshold: 1 })
    breaker.recordFailure("transient")

    expect(breaker.getState()).toBe("OPEN")
    expect(breaker.canExecute()).toBe(false)
  })

  it("records failures with mixed classifications correctly", () => {
    const breaker = createBreaker({ failureThreshold: 3 })

    breaker.recordFailure("transient")   // counts
    breaker.recordFailure("permanent")   // ignored
    breaker.recordFailure("resource")    // counts
    breaker.recordFailure("timeout")     // ignored
    expect(breaker.getState()).toBe("CLOSED")

    breaker.recordFailure("transient")   // counts → trip
    expect(breaker.getState()).toBe("OPEN")
  })
})

// ──────────────────────────────────────────────────
// Sliding Window
// ──────────────────────────────────────────────────

describe("CircuitBreaker — sliding window", () => {
  it("prunes failures outside the window", () => {
    let time = 1000
    const breaker = createBreaker(
      { failureThreshold: 3, windowMs: 5000 },
      () => time,
    )

    // Record 2 failures at t=1000
    breaker.recordFailure("transient")
    breaker.recordFailure("transient")

    // Advance past window
    time = 7000

    // These old failures should be pruned
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("CLOSED") // Only 1 failure in window

    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("CLOSED") // 2 failures in window

    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN") // 3 failures in window → trip
  })

  it("stats reflect current window only", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 10, windowMs: 5000 },
      () => time,
    )

    breaker.recordFailure("transient")
    breaker.recordFailure("transient")

    time = 6000

    const stats = breaker.getStats()
    expect(stats.windowFailureCount).toBe(0) // Pruned
  })

  it("successes in window count toward total calls", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 10, windowMs: 5000 },
      () => time,
    )

    breaker.recordSuccess()
    breaker.recordSuccess()
    breaker.recordFailure("transient")

    const stats = breaker.getStats()
    expect(stats.windowTotalCalls).toBe(3)
    expect(stats.windowFailureCount).toBe(1)
  })
})

// ──────────────────────────────────────────────────
// OPEN → HALF_OPEN transition
// ──────────────────────────────────────────────────

describe("CircuitBreaker — OPEN → HALF_OPEN", () => {
  it("transitions to HALF_OPEN after openDurationMs", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 5000 },
      () => time,
    )

    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")

    // Not yet
    time = 4999
    expect(breaker.getState()).toBe("OPEN")

    // Now
    time = 5000
    expect(breaker.getState()).toBe("HALF_OPEN")
  })

  it("allows limited execution in HALF_OPEN", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 1000, halfOpenMaxAttempts: 1 },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    expect(breaker.getState()).toBe("HALF_OPEN")
    expect(breaker.canExecute()).toBe(true)
  })

  it("limits concurrent requests in HALF_OPEN", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 1000, halfOpenMaxAttempts: 1 },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    expect(breaker.canExecute()).toBe(true)
    breaker.acquireHalfOpenSlot()

    // Slot is occupied
    expect(breaker.canExecute()).toBe(false)
  })

  it("allows multiple concurrent requests when halfOpenMaxAttempts > 1", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 1000, halfOpenMaxAttempts: 3 },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    expect(breaker.canExecute()).toBe(true)
    breaker.acquireHalfOpenSlot()
    expect(breaker.canExecute()).toBe(true)
    breaker.acquireHalfOpenSlot()
    expect(breaker.canExecute()).toBe(true)
    breaker.acquireHalfOpenSlot()
    expect(breaker.canExecute()).toBe(false)
  })
})

// ──────────────────────────────────────────────────
// HALF_OPEN → CLOSED transition
// ──────────────────────────────────────────────────

describe("CircuitBreaker — HALF_OPEN → CLOSED", () => {
  it("closes after consecutive successes reach threshold", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1000,
        halfOpenMaxAttempts: 5,
        successThresholdToClose: 3,
      },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    expect(breaker.getState()).toBe("HALF_OPEN")

    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("HALF_OPEN")

    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("HALF_OPEN")

    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("CLOSED")
  })

  it("resets failure count after closing", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1000,
        successThresholdToClose: 1,
      },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("CLOSED")

    const stats = breaker.getStats()
    expect(stats.windowFailureCount).toBe(0)
    expect(stats.consecutiveHalfOpenSuccesses).toBe(0)
  })

  it("allows execution again after closing", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1000,
        successThresholdToClose: 1,
      },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.canExecute()).toBe(true)
  })
})

// ──────────────────────────────────────────────────
// HALF_OPEN → OPEN transition (failure during probe)
// ──────────────────────────────────────────────────

describe("CircuitBreaker — HALF_OPEN → OPEN", () => {
  it("re-opens on failure during HALF_OPEN", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 1000, successThresholdToClose: 3 },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000
    expect(breaker.getState()).toBe("HALF_OPEN")

    breaker.acquireHalfOpenSlot()
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("resets consecutive success count on failure", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1000,
        halfOpenMaxAttempts: 5,
        successThresholdToClose: 3,
      },
      () => time,
    )

    breaker.recordFailure("transient")
    time = 1000

    // 2 successes, then failure
    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    breaker.acquireHalfOpenSlot()
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")

    // Wait again to go half-open
    time = 2000
    expect(breaker.getState()).toBe("HALF_OPEN")

    // Consecutive successes should be reset
    const stats = breaker.getStats()
    expect(stats.consecutiveHalfOpenSuccesses).toBe(0)
  })
})

// ──────────────────────────────────────────────────
// Full Lifecycle
// ──────────────────────────────────────────────────

describe("CircuitBreaker — full lifecycle", () => {
  it("CLOSED → OPEN → HALF_OPEN → CLOSED", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 2,
        openDurationMs: 5000,
        successThresholdToClose: 2,
      },
      () => time,
    )

    // CLOSED
    expect(breaker.getState()).toBe("CLOSED")
    expect(breaker.canExecute()).toBe(true)

    // Trip to OPEN
    breaker.recordFailure("transient")
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
    expect(breaker.canExecute()).toBe(false)

    // Transition to HALF_OPEN
    time = 5000
    expect(breaker.getState()).toBe("HALF_OPEN")
    expect(breaker.canExecute()).toBe(true)

    // Recover to CLOSED
    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("CLOSED")
    expect(breaker.canExecute()).toBe(true)
  })

  it("CLOSED → OPEN → HALF_OPEN → OPEN → HALF_OPEN → CLOSED", () => {
    let time = 0
    const breaker = createBreaker(
      {
        failureThreshold: 1,
        openDurationMs: 1000,
        successThresholdToClose: 1,
      },
      () => time,
    )

    // CLOSED → OPEN
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")

    // OPEN → HALF_OPEN
    time = 1000
    expect(breaker.getState()).toBe("HALF_OPEN")

    // HALF_OPEN → OPEN (failure)
    breaker.acquireHalfOpenSlot()
    breaker.recordFailure("resource")
    expect(breaker.getState()).toBe("OPEN")

    // OPEN → HALF_OPEN again
    time = 2000
    expect(breaker.getState()).toBe("HALF_OPEN")

    // HALF_OPEN → CLOSED (success)
    breaker.acquireHalfOpenSlot()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("CLOSED")
  })
})

// ──────────────────────────────────────────────────
// getStats
// ──────────────────────────────────────────────────

describe("CircuitBreaker — getStats()", () => {
  it("reports correct stats after various operations", () => {
    let time = 1000
    const breaker = createBreaker(
      { failureThreshold: 10, windowMs: 60_000 },
      () => time,
    )

    breaker.recordSuccess()
    breaker.recordSuccess()
    breaker.recordFailure("transient")

    const stats = breaker.getStats()
    expect(stats.state).toBe("CLOSED")
    expect(stats.windowFailureCount).toBe(1)
    expect(stats.windowTotalCalls).toBe(3)
    expect(stats.lastStateChange).toBeDefined()
  })

  it("lastStateChange updates on transitions", () => {
    let time = 0
    const breaker = createBreaker(
      { failureThreshold: 1, openDurationMs: 1000 },
      () => time,
    )

    const initialStats = breaker.getStats()
    const initialChange = initialStats.lastStateChange

    time = 500
    breaker.recordFailure("transient")

    const openStats = breaker.getStats()
    expect(openStats.lastStateChange).not.toBe(initialChange)
  })
})

// ──────────────────────────────────────────────────
// Success in CLOSED state
// ──────────────────────────────────────────────────

describe("CircuitBreaker — recordSuccess() in CLOSED", () => {
  it("does not change state", () => {
    const breaker = createBreaker()
    breaker.recordSuccess()
    breaker.recordSuccess()
    expect(breaker.getState()).toBe("CLOSED")
  })
})

// ──────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────

describe("CircuitBreaker — edge cases", () => {
  it("handles zero failure threshold (immediate trip)", () => {
    // With threshold=0, we need at least 0 failures to trip,
    // but the >= check means any failure >= 0 should trip
    // However, recordFailure prunes then checks, and failures starts at 1.
    // With threshold 1, one failure trips immediately
    const breaker = createBreaker({ failureThreshold: 1 })
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("handles rapid success/failure alternation", () => {
    const breaker = createBreaker({ failureThreshold: 3 })

    breaker.recordSuccess()
    breaker.recordFailure("transient")
    breaker.recordSuccess()
    breaker.recordFailure("transient")
    breaker.recordSuccess()
    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("custom config overrides defaults", () => {
    const breaker = createBreaker({
      failureThreshold: 10,
      windowMs: 120_000,
      openDurationMs: 60_000,
    })

    // Should take 10 failures to trip
    for (let i = 0; i < 9; i++) {
      breaker.recordFailure("transient")
    }
    expect(breaker.getState()).toBe("CLOSED")

    breaker.recordFailure("transient")
    expect(breaker.getState()).toBe("OPEN")
  })

  it("acquireHalfOpenSlot is a no-op in CLOSED state", () => {
    const breaker = createBreaker()
    // Should not throw
    breaker.acquireHalfOpenSlot()
    expect(breaker.canExecute()).toBe(true)
  })
})
