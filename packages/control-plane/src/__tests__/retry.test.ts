import { describe, expect, it } from "vitest"

import {
  calculateRetryDelay,
  calculateRunAt,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from "../worker/retry.js"

describe("calculateRetryDelay", () => {
  it("returns base delay for attempt 0 (within jitter range)", () => {
    const delay = calculateRetryDelay(0)
    // Base delay is 1000ms, jitter is ±25%, so range is [750, 1250]
    expect(delay).toBeGreaterThanOrEqual(750)
    expect(delay).toBeLessThanOrEqual(1250)
  })

  it("applies exponential backoff", () => {
    // Without jitter variation, we can test the general magnitude
    // attempt 0: 1000ms * 2^0 = 1000ms → [750, 1250]
    // attempt 1: 1000ms * 2^1 = 2000ms → [1500, 2500]
    // attempt 2: 1000ms * 2^2 = 4000ms → [3000, 5000]
    // attempt 3: 1000ms * 2^3 = 8000ms → [6000, 10000]

    const samples = Array.from({ length: 100 }, () => calculateRetryDelay(2))
    const min = Math.min(...samples)
    const max = Math.max(...samples)

    // 4000ms * 0.75 = 3000, 4000ms * 1.25 = 5000
    expect(min).toBeGreaterThanOrEqual(3000)
    expect(max).toBeLessThanOrEqual(5000)
  })

  it("caps delay at maxDelayMs", () => {
    // attempt 20: 1000 * 2^20 = 1,048,576,000ms → capped at 300,000ms
    const samples = Array.from({ length: 100 }, () => calculateRetryDelay(20))
    for (const delay of samples) {
      // Max delay is 300_000ms, with ±25% jitter: [225_000, 375_000]
      expect(delay).toBeLessThanOrEqual(375_000)
    }
  })

  it("produces different values (jitter is effective)", () => {
    const samples = Array.from({ length: 50 }, () => calculateRetryDelay(3))
    const unique = new Set(samples)
    // With 50 samples, we should get many unique values due to jitter
    expect(unique.size).toBeGreaterThan(10)
  })

  it("respects custom config", () => {
    const config: RetryConfig = {
      baseDelayMs: 5_000,
      maxDelayMs: 60_000,
      multiplier: 3,
    }

    // attempt 0: 5000 * 3^0 = 5000ms → [3750, 6250]
    const delay = calculateRetryDelay(0, config)
    expect(delay).toBeGreaterThanOrEqual(3750)
    expect(delay).toBeLessThanOrEqual(6250)

    // attempt 3: 5000 * 3^3 = 135,000ms → capped at 60,000ms → [45000, 75000]
    const cappedDelay = calculateRetryDelay(3, config)
    expect(cappedDelay).toBeLessThanOrEqual(75_000)
  })

  it("returns integer milliseconds", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = calculateRetryDelay(attempt)
      expect(Number.isInteger(delay)).toBe(true)
    }
  })

  it("produces monotonically increasing average delays", () => {
    const averages: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const samples = Array.from({ length: 200 }, () => calculateRetryDelay(attempt))
      averages.push(samples.reduce((a, b) => a + b, 0) / samples.length)
    }

    // Each subsequent attempt should have a higher average delay
    for (let i = 1; i < averages.length; i++) {
      expect(averages[i]).toBeGreaterThan(averages[i - 1]!)
    }
  })
})

describe("calculateRunAt", () => {
  it("returns a Date in the future", () => {
    const before = Date.now()
    const runAt = calculateRunAt(0)
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it("offset matches the calculated delay", () => {
    const before = Date.now()
    const runAt = calculateRunAt(0)
    const after = Date.now()

    const offset = runAt.getTime() - before
    // Should be within [750, 1250] for attempt 0 plus timing tolerance
    expect(offset).toBeGreaterThanOrEqual(700)
    expect(offset).toBeLessThanOrEqual(1300 + (after - before))
  })
})

describe("DEFAULT_RETRY_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1_000)
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(300_000)
    expect(DEFAULT_RETRY_CONFIG.multiplier).toBe(2)
  })
})
