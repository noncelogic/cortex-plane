import { describe, expect, it, vi } from "vitest"

import {
  AgentLifecycleStateMachine,
  assertValidTransition,
  InvalidTransitionError,
  isValidTransition,
  VALID_TRANSITIONS,
  type AgentLifecycleState,
} from "../lifecycle/state-machine.js"

describe("VALID_TRANSITIONS", () => {
  it("defines transitions for all states", () => {
    const states: AgentLifecycleState[] = [
      "BOOTING",
      "HYDRATING",
      "READY",
      "EXECUTING",
      "DRAINING",
      "TERMINATED",
    ]
    for (const state of states) {
      expect(VALID_TRANSITIONS).toHaveProperty(state)
      expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true)
    }
  })

  it("TERMINATED has no outbound transitions", () => {
    expect(VALID_TRANSITIONS.TERMINATED).toEqual([])
  })

  it("BOOTING can go to HYDRATING or TERMINATED", () => {
    expect(VALID_TRANSITIONS.BOOTING).toEqual(["HYDRATING", "TERMINATED"])
  })

  it("HYDRATING can go to READY or TERMINATED", () => {
    expect(VALID_TRANSITIONS.HYDRATING).toEqual(["READY", "TERMINATED"])
  })

  it("READY can go to EXECUTING or DRAINING", () => {
    expect(VALID_TRANSITIONS.READY).toEqual(["EXECUTING", "DRAINING"])
  })

  it("EXECUTING can go to DRAINING or TERMINATED", () => {
    expect(VALID_TRANSITIONS.EXECUTING).toEqual(["DRAINING", "TERMINATED"])
  })

  it("DRAINING can only go to TERMINATED", () => {
    expect(VALID_TRANSITIONS.DRAINING).toEqual(["TERMINATED"])
  })
})

describe("isValidTransition", () => {
  it("returns true for valid transitions", () => {
    expect(isValidTransition("BOOTING", "HYDRATING")).toBe(true)
    expect(isValidTransition("BOOTING", "TERMINATED")).toBe(true)
    expect(isValidTransition("HYDRATING", "READY")).toBe(true)
    expect(isValidTransition("READY", "EXECUTING")).toBe(true)
    expect(isValidTransition("READY", "DRAINING")).toBe(true)
    expect(isValidTransition("EXECUTING", "DRAINING")).toBe(true)
    expect(isValidTransition("EXECUTING", "TERMINATED")).toBe(true)
    expect(isValidTransition("DRAINING", "TERMINATED")).toBe(true)
  })

  it("returns false for invalid transitions", () => {
    // Backwards transitions
    expect(isValidTransition("HYDRATING", "BOOTING")).toBe(false)
    expect(isValidTransition("READY", "HYDRATING")).toBe(false)
    expect(isValidTransition("EXECUTING", "READY")).toBe(false)
    expect(isValidTransition("DRAINING", "EXECUTING")).toBe(false)

    // Skip-ahead transitions
    expect(isValidTransition("BOOTING", "READY")).toBe(false)
    expect(isValidTransition("BOOTING", "EXECUTING")).toBe(false)
    expect(isValidTransition("HYDRATING", "EXECUTING")).toBe(false)

    // From terminal state
    expect(isValidTransition("TERMINATED", "BOOTING")).toBe(false)
    expect(isValidTransition("TERMINATED", "READY")).toBe(false)

    // Self-transitions
    expect(isValidTransition("BOOTING", "BOOTING")).toBe(false)
    expect(isValidTransition("EXECUTING", "EXECUTING")).toBe(false)
    expect(isValidTransition("TERMINATED", "TERMINATED")).toBe(false)
  })
})

describe("assertValidTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertValidTransition("BOOTING", "HYDRATING")).not.toThrow()
    expect(() => assertValidTransition("EXECUTING", "DRAINING")).not.toThrow()
  })

  it("throws InvalidTransitionError for invalid transitions", () => {
    expect(() => assertValidTransition("TERMINATED", "BOOTING")).toThrow(InvalidTransitionError)
  })

  it("includes from/to in error", () => {
    try {
      assertValidTransition("READY", "BOOTING")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError)
      const ite = error as InvalidTransitionError
      expect(ite.from).toBe("READY")
      expect(ite.to).toBe("BOOTING")
      expect(ite.message).toContain("READY")
      expect(ite.message).toContain("BOOTING")
    }
  })
})

describe("AgentLifecycleStateMachine", () => {
  it("starts in BOOTING state", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    expect(sm.state).toBe("BOOTING")
  })

  it("transitions through the happy path", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    expect(sm.state).toBe("HYDRATING")

    sm.transition("READY")
    expect(sm.state).toBe("READY")

    sm.transition("EXECUTING")
    expect(sm.state).toBe("EXECUTING")

    sm.transition("DRAINING")
    expect(sm.state).toBe("DRAINING")

    sm.transition("TERMINATED")
    expect(sm.state).toBe("TERMINATED")
  })

  it("throws on invalid transition", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    expect(() => sm.transition("READY")).toThrow(InvalidTransitionError)
    expect(sm.state).toBe("BOOTING") // State unchanged
  })

  it("fires listener on transition", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    const listener = vi.fn()
    sm.onTransition(listener)

    sm.transition("HYDRATING", "test reason")

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0]![0]
    expect(event.from).toBe("BOOTING")
    expect(event.to).toBe("HYDRATING")
    expect(event.agentId).toBe("agent-1")
    expect(event.reason).toBe("test reason")
    expect(event.timestamp).toBeInstanceOf(Date)
  })

  it("fires multiple listeners", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    const l1 = vi.fn()
    const l2 = vi.fn()
    sm.onTransition(l1)
    sm.onTransition(l2)

    sm.transition("HYDRATING")
    expect(l1).toHaveBeenCalledOnce()
    expect(l2).toHaveBeenCalledOnce()
  })

  it("does not fire listener when transition fails", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    const listener = vi.fn()
    sm.onTransition(listener)

    expect(() => sm.transition("EXECUTING")).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  describe("isReady", () => {
    it("returns false in BOOTING", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isReady).toBe(false)
    })

    it("returns false in HYDRATING", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      expect(sm.isReady).toBe(false)
    })

    it("returns true in READY", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      expect(sm.isReady).toBe(true)
    })

    it("returns true in EXECUTING", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      expect(sm.isReady).toBe(true)
    })

    it("returns false in DRAINING", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      sm.transition("DRAINING")
      expect(sm.isReady).toBe(false)
    })
  })

  describe("isAlive", () => {
    it("returns true for all non-TERMINATED states", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isAlive).toBe(true)
      sm.transition("HYDRATING")
      expect(sm.isAlive).toBe(true)
      sm.transition("READY")
      expect(sm.isAlive).toBe(true)
      sm.transition("EXECUTING")
      expect(sm.isAlive).toBe(true)
      sm.transition("DRAINING")
      expect(sm.isAlive).toBe(true)
    })

    it("returns false in TERMINATED", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      sm.transition("HYDRATING")
      sm.transition("READY")
      sm.transition("EXECUTING")
      sm.transition("DRAINING")
      sm.transition("TERMINATED")
      expect(sm.isAlive).toBe(false)
    })
  })

  describe("isTerminal", () => {
    it("returns true only in TERMINATED", () => {
      const sm = new AgentLifecycleStateMachine("agent-1")
      expect(sm.isTerminal).toBe(false)
      sm.transition("TERMINATED")
      expect(sm.isTerminal).toBe(true)
    })
  })

  it("handles early crash path: BOOTING → TERMINATED", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("TERMINATED", "Fatal boot error")
    expect(sm.state).toBe("TERMINATED")
    expect(sm.isTerminal).toBe(true)
  })

  it("handles crash during execution: EXECUTING → TERMINATED", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("EXECUTING")
    sm.transition("TERMINATED", "OOM kill")
    expect(sm.state).toBe("TERMINATED")
  })

  it("handles SIGTERM during READY: READY → DRAINING → TERMINATED", () => {
    const sm = new AgentLifecycleStateMachine("agent-1")
    sm.transition("HYDRATING")
    sm.transition("READY")
    sm.transition("DRAINING", "SIGTERM")
    sm.transition("TERMINATED", "Drain complete")
    expect(sm.state).toBe("TERMINATED")
  })
})
