import { describe, expect, it } from "vitest"

import { DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG, resolveCircuitBreakerConfig } from "../defaults.js"

describe("DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG).toEqual({
      maxConsecutiveFailures: 3,
      maxToolErrorsPerJob: 10,
      maxLlmRetriesPerJob: 5,
      tokenBudgetPerJob: 500_000,
      tokenBudgetPerSession: 2_000_000,
      toolCallRateLimit: { maxCalls: 50, windowSeconds: 300 },
      llmCallRateLimit: { maxCalls: 20, windowSeconds: 300 },
    })
  })
})

describe("resolveCircuitBreakerConfig", () => {
  it("returns undefined when resource_limits has no circuitBreaker key", () => {
    expect(resolveCircuitBreakerConfig({})).toBeUndefined()
  })

  it("returns undefined when circuitBreaker is null", () => {
    expect(resolveCircuitBreakerConfig({ circuitBreaker: null })).toBeUndefined()
  })

  it("returns undefined when circuitBreaker is a primitive", () => {
    expect(resolveCircuitBreakerConfig({ circuitBreaker: 42 })).toBeUndefined()
    expect(resolveCircuitBreakerConfig({ circuitBreaker: "yes" })).toBeUndefined()
    expect(resolveCircuitBreakerConfig({ circuitBreaker: true })).toBeUndefined()
  })

  it("returns the object when circuitBreaker is a valid partial config", () => {
    const partial = { maxConsecutiveFailures: 5 }
    const result = resolveCircuitBreakerConfig({ circuitBreaker: partial })
    expect(result).toEqual({ maxConsecutiveFailures: 5 })
  })

  it("returns the full object for a complete config", () => {
    const full = {
      maxConsecutiveFailures: 10,
      maxToolErrorsPerJob: 20,
      maxLlmRetriesPerJob: 8,
      tokenBudgetPerJob: 1_000_000,
      tokenBudgetPerSession: 5_000_000,
      toolCallRateLimit: { maxCalls: 100, windowSeconds: 600 },
      llmCallRateLimit: { maxCalls: 40, windowSeconds: 600 },
    }
    const result = resolveCircuitBreakerConfig({ circuitBreaker: full })
    expect(result).toEqual(full)
  })

  it("ignores unrelated keys in resource_limits", () => {
    const result = resolveCircuitBreakerConfig({
      contextBudget: { maxTokens: 100_000 },
      circuitBreaker: { tokenBudgetPerJob: 200_000 },
    })
    expect(result).toEqual({ tokenBudgetPerJob: 200_000 })
  })
})
