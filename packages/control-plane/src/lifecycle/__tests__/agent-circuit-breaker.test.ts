import { describe, expect, it } from "vitest"

import {
  AgentCircuitBreaker,
  DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG,
} from "../agent-circuit-breaker.js"

// ---------------------------------------------------------------------------
// Constructor + defaults
// ---------------------------------------------------------------------------

describe("AgentCircuitBreaker", () => {
  it("starts un-tripped with zero counters", () => {
    const cb = new AgentCircuitBreaker("agent-1")
    expect(cb.tripped).toBe(false)
    expect(cb.tripReason).toBeNull()
    const state = cb.getState()
    expect(state.consecutiveJobFailures).toBe(0)
    expect(state.currentJobToolErrors).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Consecutive job failures → quarantine
  // -------------------------------------------------------------------------

  describe("shouldQuarantine", () => {
    it("does not quarantine below threshold", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordJobFailure()
      cb.recordJobFailure()
      expect(cb.shouldQuarantine().quarantine).toBe(false)
    })

    it("quarantines after 3 consecutive failures (default threshold)", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordJobFailure()
      cb.recordJobFailure()
      cb.recordJobFailure()
      const decision = cb.shouldQuarantine()
      expect(decision.quarantine).toBe(true)
      expect(decision.reason).toContain("3 consecutive job failures")
      expect(cb.tripped).toBe(true)
    })

    it("resets consecutive failures on job success", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordJobFailure()
      cb.recordJobFailure()
      cb.recordJobSuccess()
      cb.recordJobFailure()
      expect(cb.shouldQuarantine().quarantine).toBe(false)
      expect(cb.getState().consecutiveJobFailures).toBe(1)
    })

    it("respects custom maxConsecutiveFailures", () => {
      const cb = new AgentCircuitBreaker("agent-1", { maxConsecutiveFailures: 5 })
      for (let i = 0; i < 4; i++) cb.recordJobFailure()
      expect(cb.shouldQuarantine().quarantine).toBe(false)
      cb.recordJobFailure()
      expect(cb.shouldQuarantine().quarantine).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Job abort conditions
  // -------------------------------------------------------------------------

  describe("shouldAbortJob", () => {
    it("aborts on tool errors exceeding threshold", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.maxToolErrorsPerJob; i++) {
        cb.recordToolError()
      }
      const decision = cb.shouldAbortJob()
      expect(decision.abort).toBe(true)
      expect(decision.reason).toContain("tool_errors")
    })

    it("does not abort below tool error threshold", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.maxToolErrorsPerJob - 1; i++) {
        cb.recordToolError()
      }
      expect(cb.shouldAbortJob().abort).toBe(false)
    })

    it("aborts on LLM retries exceeding threshold", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.maxLlmRetriesPerJob; i++) {
        cb.recordLlmRetry()
      }
      const decision = cb.shouldAbortJob()
      expect(decision.abort).toBe(true)
      expect(decision.reason).toContain("llm_retries")
    })

    it("aborts when per-job token budget is exceeded", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordTokenUsage(DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.tokenBudgetPerJob + 1)
      const decision = cb.shouldAbortJob()
      expect(decision.abort).toBe(true)
      expect(decision.reason).toContain("token_budget")
    })

    it("aborts when per-session token budget is exceeded", () => {
      // Use a high per-job budget so per-job check passes; low session budget triggers first
      const cb = new AgentCircuitBreaker("agent-1", {
        tokenBudgetPerJob: 10_000_000,
        tokenBudgetPerSession: 500,
      })
      cb.recordTokenUsage(501)
      const decision = cb.shouldAbortJob()
      expect(decision.abort).toBe(true)
      expect(decision.reason).toContain("session_token_budget")
    })

    it("does not abort when everything is within limits", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordToolError()
      cb.recordLlmRetry()
      cb.recordTokenUsage(100)
      expect(cb.shouldAbortJob().abort).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Tool call rate limiting
  // -------------------------------------------------------------------------

  describe("recordToolCall", () => {
    it("allows calls within the rate limit", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      const now = Date.now()
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.toolCallRateLimit.maxCalls; i++) {
        expect(cb.recordToolCall(now + i)).toBe(true)
      }
    })

    it("rejects calls exceeding the rate limit", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      const now = Date.now()
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.toolCallRateLimit.maxCalls; i++) {
        cb.recordToolCall(now)
      }
      expect(cb.recordToolCall(now)).toBe(false)
    })

    it("allows calls after the window expires", () => {
      const cb = new AgentCircuitBreaker("agent-1", {
        toolCallRateLimit: { maxCalls: 2, windowSeconds: 10 },
      })
      const now = Date.now()
      cb.recordToolCall(now)
      cb.recordToolCall(now)
      expect(cb.recordToolCall(now)).toBe(false)
      // 11 seconds later, old calls are pruned
      expect(cb.recordToolCall(now + 11_000)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // LLM call rate limiting
  // -------------------------------------------------------------------------

  describe("recordLlmCall", () => {
    it("allows calls within the rate limit", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      const now = Date.now()
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.llmCallRateLimit.maxCalls; i++) {
        expect(cb.recordLlmCall(now + i)).toBe(true)
      }
    })

    it("rejects calls exceeding the rate limit", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      const now = Date.now()
      for (let i = 0; i < DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG.llmCallRateLimit.maxCalls; i++) {
        cb.recordLlmCall(now)
      }
      expect(cb.recordLlmCall(now)).toBe(false)
    })

    it("allows calls after the window expires", () => {
      const cb = new AgentCircuitBreaker("agent-1", {
        llmCallRateLimit: { maxCalls: 2, windowSeconds: 5 },
      })
      const now = Date.now()
      cb.recordLlmCall(now)
      cb.recordLlmCall(now)
      expect(cb.recordLlmCall(now)).toBe(false)
      expect(cb.recordLlmCall(now + 6_000)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Token usage tracking
  // -------------------------------------------------------------------------

  describe("recordTokenUsage", () => {
    it("returns true within budget", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      expect(cb.recordTokenUsage(1_000)).toBe(true)
    })

    it("returns false when per-job budget exceeded", () => {
      const cb = new AgentCircuitBreaker("agent-1", { tokenBudgetPerJob: 100 })
      expect(cb.recordTokenUsage(101)).toBe(false)
    })

    it("accumulates across multiple calls", () => {
      const cb = new AgentCircuitBreaker("agent-1", { tokenBudgetPerJob: 100 })
      expect(cb.recordTokenUsage(50)).toBe(true)
      expect(cb.recordTokenUsage(51)).toBe(false)
    })

    it("tracks session tokens across job resets", () => {
      const cb = new AgentCircuitBreaker("agent-1", {
        tokenBudgetPerJob: 1_000,
        tokenBudgetPerSession: 200,
      })
      cb.recordTokenUsage(100)
      cb.recordJobSuccess() // resets per-job counters
      // session total is still 100; add 101 more → session exceeds 200
      expect(cb.recordTokenUsage(101)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe("reset", () => {
    it("clears all counters and untrips the breaker", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      cb.recordJobFailure()
      cb.recordJobFailure()
      cb.recordJobFailure()
      cb.shouldQuarantine() // trips
      expect(cb.tripped).toBe(true)

      cb.reset()

      expect(cb.tripped).toBe(false)
      expect(cb.tripReason).toBeNull()
      const state = cb.getState()
      expect(state.consecutiveJobFailures).toBe(0)
      expect(state.currentJobToolErrors).toBe(0)
      expect(state.currentJobLlmRetries).toBe(0)
      expect(state.currentJobTokensUsed).toBe(0)
      expect(state.currentSessionTokensUsed).toBe(0)
      expect(state.toolCallTimestamps).toHaveLength(0)
      expect(state.llmCallTimestamps).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getState snapshot
  // -------------------------------------------------------------------------

  describe("getState", () => {
    it("returns a snapshot (not a reference)", () => {
      const cb = new AgentCircuitBreaker("agent-1")
      const s1 = cb.getState()
      cb.recordJobFailure()
      const s2 = cb.getState()
      expect(s1.consecutiveJobFailures).toBe(0)
      expect(s2.consecutiveJobFailures).toBe(1)
    })
  })
})
