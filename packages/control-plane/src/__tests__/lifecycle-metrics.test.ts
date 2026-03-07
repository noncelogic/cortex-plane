import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  emitLifecycleLog,
  recordCheckpointWrite,
  recordCircuitBreakerTrip,
  recordContextBudgetExceeded,
  recordOutputValidationRejected,
  recordStateTransition,
  recordTokenUsage,
} from "../lifecycle/metrics.js"
import type { LifecycleTransitionEvent } from "../lifecycle/state-machine.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture structured log lines written to stdout. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") lines.push(chunk.trim())
    else original(chunk)
    return true
  })
  return { lines, restore: () => spy.mockRestore() }
}

function parseLogLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lifecycle metrics", () => {
  let capture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    capture = captureStdout()
  })

  afterEach(() => {
    capture.restore()
  })

  // -------------------------------------------------------------------------
  // emitLifecycleLog
  // -------------------------------------------------------------------------

  describe("emitLifecycleLog", () => {
    it("emits structured JSON with required fields", () => {
      emitLifecycleLog({
        event: "agent.test",
        agentId: "a-1",
        from: "BOOTING",
        to: "HYDRATING",
        reason: "test reason",
      })

      expect(capture.lines).toHaveLength(1)
      const log = parseLogLine(capture.lines[0]!)
      expect(log.level).toBe("info")
      expect(log.service).toBe("cortex-lifecycle")
      expect(log.event).toBe("agent.test")
      expect(log.agentId).toBe("a-1")
      expect(log.from).toBe("BOOTING")
      expect(log.to).toBe("HYDRATING")
      expect(log.reason).toBe("test reason")
      expect(log.time).toBeDefined()
    })

    it("includes metadata when provided", () => {
      emitLifecycleLog({
        event: "agent.custom",
        agentId: "a-1",
        metadata: { foo: "bar" },
      })

      const log = parseLogLine(capture.lines[0]!)
      expect(log.metadata).toEqual({ foo: "bar" })
    })
  })

  // -------------------------------------------------------------------------
  // recordStateTransition
  // -------------------------------------------------------------------------

  describe("recordStateTransition", () => {
    it("emits state transition log with event, agentId, from, to, reason", () => {
      const event: LifecycleTransitionEvent = {
        from: "BOOTING",
        to: "HYDRATING",
        timestamp: new Date(),
        agentId: "agent-42",
        reason: "Config loaded",
      }

      recordStateTransition(event)

      expect(capture.lines).toHaveLength(1)
      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.state_transition")
      expect(log.agentId).toBe("agent-42")
      expect(log.from).toBe("BOOTING")
      expect(log.to).toBe("HYDRATING")
      expect(log.reason).toBe("Config loaded")
    })
  })

  // -------------------------------------------------------------------------
  // recordCircuitBreakerTrip
  // -------------------------------------------------------------------------

  describe("recordCircuitBreakerTrip", () => {
    it("emits circuit breaker trip log", () => {
      recordCircuitBreakerTrip("agent-7", "consecutive failures exceeded threshold")

      expect(capture.lines).toHaveLength(1)
      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.circuit_breaker.tripped")
      expect(log.agentId).toBe("agent-7")
      expect(log.reason).toBe("consecutive failures exceeded threshold")
    })
  })

  // -------------------------------------------------------------------------
  // recordContextBudgetExceeded
  // -------------------------------------------------------------------------

  describe("recordContextBudgetExceeded", () => {
    it("emits context budget exceeded log with component", () => {
      recordContextBudgetExceeded("agent-3", "qdrant-context")

      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.context_budget.exceeded")
      expect(log.agentId).toBe("agent-3")
      expect(log.metadata).toEqual({ component: "qdrant-context" })
    })
  })

  // -------------------------------------------------------------------------
  // recordOutputValidationRejected
  // -------------------------------------------------------------------------

  describe("recordOutputValidationRejected", () => {
    it("emits output validation rejected log with content_type", () => {
      recordOutputValidationRejected("agent-5", "memory")

      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.output_validation.rejected")
      expect(log.agentId).toBe("agent-5")
      expect(log.metadata).toEqual({ contentType: "memory" })
    })
  })

  // -------------------------------------------------------------------------
  // recordCheckpointWrite
  // -------------------------------------------------------------------------

  describe("recordCheckpointWrite", () => {
    it("emits checkpoint write log with trigger", () => {
      recordCheckpointWrite("agent-9", "drain")

      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.checkpoint.written")
      expect(log.agentId).toBe("agent-9")
      expect(log.metadata).toEqual({ trigger: "drain" })
    })
  })

  // -------------------------------------------------------------------------
  // recordTokenUsage
  // -------------------------------------------------------------------------

  describe("recordTokenUsage", () => {
    it("emits token usage log with jobId and token count", () => {
      recordTokenUsage("agent-11", "job-99", 1500)

      const log = parseLogLine(capture.lines[0]!)
      expect(log.event).toBe("agent.token_usage")
      expect(log.agentId).toBe("agent-11")
      expect(log.jobId).toBe("job-99")
      expect(log.metadata).toEqual({ tokens: 1500 })
    })
  })
})
