import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_IDLE_TIMEOUT_MS, IdleDetector } from "../lifecycle/idle-detector.js"

describe("IdleDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires onIdle callback after timeout", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")

    // Advance past timeout
    vi.advanceTimersByTime(1001)

    expect(onIdle).toHaveBeenCalledWith("agent-1")
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it("does not fire before timeout", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 5000 })

    detector.recordActivity("agent-1")
    vi.advanceTimersByTime(4999)

    expect(onIdle).not.toHaveBeenCalled()
  })

  it("resets timer on new activity", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")
    vi.advanceTimersByTime(800)

    // New activity resets the timer
    detector.recordActivity("agent-1")
    vi.advanceTimersByTime(800)

    // Only 800ms since last activity — not yet idle
    expect(onIdle).not.toHaveBeenCalled()

    // 200ms more — now past timeout
    vi.advanceTimersByTime(201)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it("tracks multiple agents independently", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")
    vi.advanceTimersByTime(500)
    detector.recordActivity("agent-2")

    // 500ms later: agent-1 times out, agent-2 has 500ms left
    vi.advanceTimersByTime(501)
    expect(onIdle).toHaveBeenCalledWith("agent-1")
    expect(onIdle).toHaveBeenCalledTimes(1)

    // 500ms more: agent-2 times out
    vi.advanceTimersByTime(501)
    expect(onIdle).toHaveBeenCalledWith("agent-2")
    expect(onIdle).toHaveBeenCalledTimes(2)
  })

  it("removes agent from tracking on timeout", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")
    expect(detector.trackedCount).toBe(1)

    vi.advanceTimersByTime(1001)
    expect(detector.trackedCount).toBe(0)
  })

  it("removeAgent cancels pending timeout", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")
    detector.removeAgent("agent-1")

    vi.advanceTimersByTime(2000)
    expect(onIdle).not.toHaveBeenCalled()
    expect(detector.trackedCount).toBe(0)
  })

  it("getLastActivity returns timestamp", () => {
    const detector = new IdleDetector({ onIdle: vi.fn() })
    const now = new Date("2026-02-24T10:00:00Z")

    detector.recordActivity("agent-1", now)
    expect(detector.getLastActivity("agent-1")).toEqual(now)
  })

  it("getLastActivity returns undefined for untracked agent", () => {
    const detector = new IdleDetector({ onIdle: vi.fn() })
    expect(detector.getLastActivity("unknown")).toBeUndefined()
  })

  it("timeUntilIdle returns remaining time", () => {
    const detector = new IdleDetector({ onIdle: vi.fn(), idleTimeoutMs: 10_000 })
    const t0 = new Date("2026-02-24T10:00:00Z")
    detector.recordActivity("agent-1", t0)

    const t1 = new Date(t0.getTime() + 3000)
    expect(detector.timeUntilIdle("agent-1", t1)).toBe(7000)
  })

  it("timeUntilIdle returns 0 for untracked agent", () => {
    const detector = new IdleDetector({ onIdle: vi.fn() })
    expect(detector.timeUntilIdle("unknown")).toBe(0)
  })

  it("timeUntilIdle returns 0 when past timeout", () => {
    const detector = new IdleDetector({ onIdle: vi.fn(), idleTimeoutMs: 1000 })
    const t0 = new Date("2026-02-24T10:00:00Z")
    detector.recordActivity("agent-1", t0)

    const t1 = new Date(t0.getTime() + 5000)
    expect(detector.timeUntilIdle("agent-1", t1)).toBe(0)
  })

  it("uses default idle timeout", () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(30 * 60_000)
  })

  it("shutdown clears all timers and agents", () => {
    const onIdle = vi.fn()
    const detector = new IdleDetector({ onIdle, idleTimeoutMs: 1000 })

    detector.recordActivity("agent-1")
    detector.recordActivity("agent-2")
    expect(detector.trackedCount).toBe(2)

    detector.shutdown()
    expect(detector.trackedCount).toBe(0)

    // Timers should not fire after shutdown
    vi.advanceTimersByTime(5000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
