import { describe, expect, it } from "vitest"

import {
  AgentLifecycleStateMachine,
  assertValidTransition,
  InvalidTransitionError,
  isValidTransition,
  VALID_TRANSITIONS,
} from "../state-machine.js"

// ---------------------------------------------------------------------------
// isValidTransition (static)
// ---------------------------------------------------------------------------

describe("isValidTransition", () => {
  it("allows BOOTING → HYDRATING", () => {
    expect(isValidTransition("BOOTING", "HYDRATING")).toBe(true)
  })

  it("allows BOOTING → TERMINATED", () => {
    expect(isValidTransition("BOOTING", "TERMINATED")).toBe(true)
  })

  it("rejects BOOTING → EXECUTING", () => {
    expect(isValidTransition("BOOTING", "EXECUTING")).toBe(false)
  })

  it("allows EXECUTING → DEGRADED", () => {
    expect(isValidTransition("EXECUTING", "DEGRADED")).toBe(true)
  })

  it("allows EXECUTING → QUARANTINED", () => {
    expect(isValidTransition("EXECUTING", "QUARANTINED")).toBe(true)
  })

  it("allows DEGRADED → EXECUTING (subsystem recovery)", () => {
    expect(isValidTransition("DEGRADED", "EXECUTING")).toBe(true)
  })

  it("allows DEGRADED → QUARANTINED", () => {
    expect(isValidTransition("DEGRADED", "QUARANTINED")).toBe(true)
  })

  it("allows DEGRADED → DRAINING", () => {
    expect(isValidTransition("DEGRADED", "DRAINING")).toBe(true)
  })

  it("allows DEGRADED → TERMINATED (crash)", () => {
    expect(isValidTransition("DEGRADED", "TERMINATED")).toBe(true)
  })

  it("allows QUARANTINED → DRAINING (operator release)", () => {
    expect(isValidTransition("QUARANTINED", "DRAINING")).toBe(true)
  })

  it("allows QUARANTINED → TERMINATED", () => {
    expect(isValidTransition("QUARANTINED", "TERMINATED")).toBe(true)
  })

  it("rejects QUARANTINED → EXECUTING (must go through DRAINING → re-boot)", () => {
    expect(isValidTransition("QUARANTINED", "EXECUTING")).toBe(false)
  })

  it("allows SAFE_MODE → READY", () => {
    expect(isValidTransition("SAFE_MODE", "READY")).toBe(true)
  })

  it("allows SAFE_MODE → TERMINATED", () => {
    expect(isValidTransition("SAFE_MODE", "TERMINATED")).toBe(true)
  })

  it("rejects SAFE_MODE → EXECUTING (must go through READY first)", () => {
    expect(isValidTransition("SAFE_MODE", "EXECUTING")).toBe(false)
  })

  it("rejects transitions out of TERMINATED", () => {
    expect(isValidTransition("TERMINATED", "BOOTING")).toBe(false)
    expect(isValidTransition("TERMINATED", "READY")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// assertValidTransition
// ---------------------------------------------------------------------------

describe("assertValidTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertValidTransition("BOOTING", "HYDRATING")).not.toThrow()
    expect(() => assertValidTransition("EXECUTING", "DEGRADED")).not.toThrow()
    expect(() => assertValidTransition("SAFE_MODE", "READY")).not.toThrow()
  })

  it("throws InvalidTransitionError for invalid transitions", () => {
    expect(() => assertValidTransition("BOOTING", "EXECUTING")).toThrow(InvalidTransitionError)
  })

  it("includes from/to in the error", () => {
    try {
      assertValidTransition("QUARANTINED", "EXECUTING")
      expect.unreachable("should have thrown")
    } catch (err) {
      const ite = err as InvalidTransitionError
      expect(ite.from).toBe("QUARANTINED")
      expect(ite.to).toBe("EXECUTING")
    }
  })
})

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS completeness
// ---------------------------------------------------------------------------

describe("VALID_TRANSITIONS", () => {
  it("has entries for all 9 states", () => {
    const states = [
      "BOOTING",
      "HYDRATING",
      "READY",
      "EXECUTING",
      "DRAINING",
      "TERMINATED",
      "DEGRADED",
      "QUARANTINED",
      "SAFE_MODE",
    ] as const
    for (const s of states) {
      expect(VALID_TRANSITIONS).toHaveProperty(s)
    }
    expect(Object.keys(VALID_TRANSITIONS)).toHaveLength(states.length)
  })

  it("TERMINATED has no outgoing transitions", () => {
    expect(VALID_TRANSITIONS["TERMINATED"]).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AgentLifecycleStateMachine
// ---------------------------------------------------------------------------

describe("AgentLifecycleStateMachine", () => {
  it("starts in BOOTING", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    expect(sm.state).toBe("BOOTING")
  })

  it("transitions through the happy path", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("DRAINING")
    sm.transition("TERMINATED")
    expect(sm.state).toBe("TERMINATED")
  })

  it("transitions EXECUTING → DEGRADED → EXECUTING (recovery)", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("DEGRADED", "Qdrant unreachable")
    expect(sm.state).toBe("DEGRADED")
    sm.transition("EXECUTING", "Qdrant recovered")
    expect(sm.state).toBe("EXECUTING")
  })

  it("transitions EXECUTING → QUARANTINED", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("QUARANTINED", "3 consecutive failures")
    expect(sm.state).toBe("QUARANTINED")
  })

  it("transitions DEGRADED → QUARANTINED", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("DEGRADED")
    sm.transition("QUARANTINED", "operator quarantine")
    expect(sm.state).toBe("QUARANTINED")
  })

  it("transitions QUARANTINED → DRAINING (operator release)", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("QUARANTINED")
    sm.transition("DRAINING", "operator released")
    sm.transition("TERMINATED")
    expect(sm.state).toBe("TERMINATED")
  })

  it("throws on QUARANTINED → EXECUTING", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("QUARANTINED")
    expect(() => sm.transition("EXECUTING")).toThrow(InvalidTransitionError)
  })

  it("fires transition listeners", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    const events: Array<{ from: string; to: string }> = []
    sm.onTransition((e) => events.push({ from: e.from, to: e.to }))

    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("DEGRADED")

    expect(events).toHaveLength(4)
    expect(events[3]).toEqual({ from: "EXECUTING", to: "DEGRADED" })
  })

  it("includes reason in transition events", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    let capturedReason: string | undefined
    sm.onTransition((e) => {
      capturedReason = e.reason
    })
    sm.transition("HYDRATING", "config loaded")
    expect(capturedReason).toBe("config loaded")
  })

  // -----------------------------------------------------------------------
  // Helper getters
  // -----------------------------------------------------------------------

  describe("isReady", () => {
    it("returns true for READY", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      expect(sm.isReady).toBe(true)
    })

    it("returns true for EXECUTING", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      expect(sm.isReady).toBe(true)
    })

    it("returns true for DEGRADED (still serving)", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      sm.transition("DEGRADED")
      expect(sm.isReady).toBe(true)
    })

    it("returns false for QUARANTINED", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      sm.transition("QUARANTINED")
      expect(sm.isReady).toBe(false)
    })
  })

  describe("isDegraded", () => {
    it("returns true only in DEGRADED state", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isDegraded).toBe(false)
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      expect(sm.isDegraded).toBe(false)
      sm.transition("DEGRADED")
      expect(sm.isDegraded).toBe(true)
    })
  })

  describe("isQuarantined", () => {
    it("returns true only in QUARANTINED state", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      expect(sm.isQuarantined).toBe(false)
      sm.transition("QUARANTINED")
      expect(sm.isQuarantined).toBe(true)
    })
  })

  describe("isSafeMode", () => {
    it("returns false for normal boot path", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isSafeMode).toBe(false)
    })
  })

  describe("isAlive", () => {
    it("returns true for non-terminal states", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isAlive).toBe(true)
      sm.transition("HYDRATING")
      expect(sm.isAlive).toBe(true)
    })

    it("returns false for TERMINATED", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("TERMINATED")
      expect(sm.isAlive).toBe(false)
    })
  })

  describe("isTerminal", () => {
    it("returns true only for TERMINATED", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isTerminal).toBe(false)
      sm.transition("TERMINATED")
      expect(sm.isTerminal).toBe(true)
    })
  })
})
