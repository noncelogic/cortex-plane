import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  type AgentHeartbeat,
  calculateCrashCooldown,
  CRASH_COOLDOWN,
  CrashLoopDetector,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HeartbeatReceiver,
  isLivenessHealthy,
  isReadinessHealthy,
} from "../lifecycle/health.js"

// ---------------------------------------------------------------------------
// CrashLoopBackOff cooldown calculation
// ---------------------------------------------------------------------------

describe("calculateCrashCooldown", () => {
  it("returns 0 for 0 or negative crashes", () => {
    expect(calculateCrashCooldown(0)).toBe(0)
    expect(calculateCrashCooldown(-1)).toBe(0)
  })

  it("returns base cooldown (1 minute) for first crash", () => {
    expect(calculateCrashCooldown(1)).toBe(60_000)
  })

  it("doubles cooldown for each consecutive crash", () => {
    // 1min, 2min, 4min, 8min
    expect(calculateCrashCooldown(1)).toBe(60_000)
    expect(calculateCrashCooldown(2)).toBe(120_000)
    expect(calculateCrashCooldown(3)).toBe(240_000)
    expect(calculateCrashCooldown(4)).toBe(480_000)
  })

  it("caps at 15 minutes", () => {
    // 2^4 * 60_000 = 960_000 > 900_000, capped
    expect(calculateCrashCooldown(5)).toBe(CRASH_COOLDOWN.maxMs)
    expect(calculateCrashCooldown(10)).toBe(CRASH_COOLDOWN.maxMs)
    expect(calculateCrashCooldown(100)).toBe(CRASH_COOLDOWN.maxMs)
  })

  it("max cooldown is exactly 15 minutes", () => {
    expect(CRASH_COOLDOWN.maxMs).toBe(15 * 60_000)
  })
})

// ---------------------------------------------------------------------------
// CrashLoopDetector
// ---------------------------------------------------------------------------

describe("CrashLoopDetector", () => {
  it("tracks first crash", () => {
    const detector = new CrashLoopDetector()
    const now = new Date("2026-02-24T10:00:00Z")
    const record = detector.recordCrash("agent-1", now)

    expect(record.crashCount).toBe(1)
    expect(record.lastCrashAt).toEqual(now)
    expect(record.cooldownUntil.getTime()).toBe(now.getTime() + 60_000)
  })

  it("increments crash count for consecutive crashes", () => {
    const detector = new CrashLoopDetector()
    const t1 = new Date("2026-02-24T10:00:00Z")
    const t2 = new Date("2026-02-24T10:01:30Z") // 90s later, within 30min window

    detector.recordCrash("agent-1", t1)
    const record = detector.recordCrash("agent-1", t2)

    expect(record.crashCount).toBe(2)
    expect(record.cooldownUntil.getTime()).toBe(t2.getTime() + 120_000)
  })

  it("resets crash count after window expires", () => {
    const detector = new CrashLoopDetector(30 * 60_000)
    const t1 = new Date("2026-02-24T10:00:00Z")
    const t2 = new Date("2026-02-24T10:31:00Z") // 31 min later, outside 30min window

    detector.recordCrash("agent-1", t1)
    const record = detector.recordCrash("agent-1", t2)

    expect(record.crashCount).toBe(1) // Reset
  })

  it("isInCooldown returns true during cooldown", () => {
    const detector = new CrashLoopDetector()
    const now = new Date("2026-02-24T10:00:00Z")
    detector.recordCrash("agent-1", now)

    // 30 seconds later (within 60s cooldown)
    const check = new Date("2026-02-24T10:00:30Z")
    expect(detector.isInCooldown("agent-1", check)).toBe(true)
  })

  it("isInCooldown returns false after cooldown expires", () => {
    const detector = new CrashLoopDetector()
    const now = new Date("2026-02-24T10:00:00Z")
    detector.recordCrash("agent-1", now)

    // 61 seconds later (past 60s cooldown)
    const check = new Date("2026-02-24T10:01:01Z")
    expect(detector.isInCooldown("agent-1", check)).toBe(false)
  })

  it("isInCooldown returns false for unknown agents", () => {
    const detector = new CrashLoopDetector()
    expect(detector.isInCooldown("unknown-agent")).toBe(false)
  })

  it("resetCrashes clears the crash record", () => {
    const detector = new CrashLoopDetector()
    detector.recordCrash("agent-1")
    detector.resetCrashes("agent-1")

    expect(detector.getCrashRecord("agent-1")).toBeUndefined()
    expect(detector.isInCooldown("agent-1")).toBe(false)
  })

  it("escalating cooldowns for multiple crashes", () => {
    const detector = new CrashLoopDetector()
    const base = new Date("2026-02-24T10:00:00Z")

    // Crash 1: 1 min cooldown
    const r1 = detector.recordCrash("agent-1", base)
    expect(r1.cooldownUntil.getTime() - base.getTime()).toBe(60_000)

    // Crash 2: 2 min cooldown
    const t2 = new Date(base.getTime() + 90_000)
    const r2 = detector.recordCrash("agent-1", t2)
    expect(r2.cooldownUntil.getTime() - t2.getTime()).toBe(120_000)

    // Crash 3: 4 min cooldown
    const t3 = new Date(t2.getTime() + 150_000)
    const r3 = detector.recordCrash("agent-1", t3)
    expect(r3.cooldownUntil.getTime() - t3.getTime()).toBe(240_000)

    // Crash 4: 8 min cooldown
    const t4 = new Date(t3.getTime() + 300_000)
    const r4 = detector.recordCrash("agent-1", t4)
    expect(r4.cooldownUntil.getTime() - t4.getTime()).toBe(480_000)

    // Crash 5: 15 min (capped)
    const t5 = new Date(t4.getTime() + 600_000)
    const r5 = detector.recordCrash("agent-1", t5)
    expect(r5.cooldownUntil.getTime() - t5.getTime()).toBe(CRASH_COOLDOWN.maxMs)
  })
})

// ---------------------------------------------------------------------------
// HeartbeatReceiver
// ---------------------------------------------------------------------------

function makeHeartbeat(agentId: string, timestamp: Date): AgentHeartbeat {
  return {
    type: "heartbeat",
    timestamp: timestamp.toISOString(),
    agentId,
    jobId: "job-1",
    podName: `pod-${agentId}`,
    lifecycleState: "EXECUTING",
    currentStep: 1,
    metrics: {
      heapUsedMb: 128,
      uptimeSeconds: 60,
      stepsCompleted: 1,
      llmCallsTotal: 1,
      toolCallsTotal: 0,
    },
  }
}

describe("HeartbeatReceiver", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("records heartbeat and marks agent HEALTHY", () => {
    const receiver = new HeartbeatReceiver()
    const now = new Date("2026-02-24T10:00:00Z")

    receiver.recordHeartbeat(makeHeartbeat("agent-1", now))

    const health = receiver.getHealth("agent-1")
    expect(health).toBeDefined()
    expect(health!.healthStatus).toBe("HEALTHY")
    expect(health!.consecutiveMisses).toBe(0)
  })

  it("marks agent WARNING after one missed heartbeat", () => {
    const receiver = new HeartbeatReceiver()
    const t0 = new Date("2026-02-24T10:00:00Z")
    receiver.recordHeartbeat(makeHeartbeat("agent-1", t0))

    // 20 seconds later (missed one 15s heartbeat)
    const t1 = new Date(t0.getTime() + 20_000)
    const unhealthy = receiver.evaluateHealth(t1)

    const health = receiver.getHealth("agent-1")
    expect(health!.healthStatus).toBe("WARNING")
    expect(health!.consecutiveMisses).toBe(1)
    expect(unhealthy).toHaveLength(0)
  })

  it("marks agent UNHEALTHY after heartbeat timeout (45s)", () => {
    const receiver = new HeartbeatReceiver()
    const t0 = new Date("2026-02-24T10:00:00Z")
    receiver.recordHeartbeat(makeHeartbeat("agent-1", t0))

    // 46 seconds later (past 45s timeout)
    const t1 = new Date(t0.getTime() + HEARTBEAT_TIMEOUT_MS + 1000)
    const unhealthy = receiver.evaluateHealth(t1)

    const health = receiver.getHealth("agent-1")
    expect(health!.healthStatus).toBe("UNHEALTHY")
    expect(unhealthy).toHaveLength(1)
    expect(unhealthy[0]!.agentId).toBe("agent-1")
  })

  it("resets to HEALTHY on fresh heartbeat", () => {
    const receiver = new HeartbeatReceiver()
    const t0 = new Date("2026-02-24T10:00:00Z")
    receiver.recordHeartbeat(makeHeartbeat("agent-1", t0))

    // Miss heartbeats
    const t1 = new Date(t0.getTime() + HEARTBEAT_TIMEOUT_MS + 1000)
    receiver.evaluateHealth(t1)
    expect(receiver.getHealth("agent-1")!.healthStatus).toBe("UNHEALTHY")

    // Fresh heartbeat arrives
    receiver.recordHeartbeat(makeHeartbeat("agent-1", t1))
    expect(receiver.getHealth("agent-1")!.healthStatus).toBe("HEALTHY")
    expect(receiver.getHealth("agent-1")!.consecutiveMisses).toBe(0)
  })

  it("tracks multiple agents independently", () => {
    const receiver = new HeartbeatReceiver()
    const t0 = new Date("2026-02-24T10:00:00Z")

    receiver.recordHeartbeat(makeHeartbeat("agent-1", t0))
    receiver.recordHeartbeat(makeHeartbeat("agent-2", t0))

    // Only agent-1 misses heartbeats
    const t1 = new Date(t0.getTime() + HEARTBEAT_TIMEOUT_MS + 1000)
    receiver.recordHeartbeat(makeHeartbeat("agent-2", t1))
    const unhealthy = receiver.evaluateHealth(t1)

    expect(unhealthy).toHaveLength(1)
    expect(unhealthy[0]!.agentId).toBe("agent-1")
    expect(receiver.getHealth("agent-2")!.healthStatus).toBe("HEALTHY")
  })

  it("removes agent from tracking", () => {
    const receiver = new HeartbeatReceiver()
    receiver.recordHeartbeat(makeHeartbeat("agent-1", new Date()))
    receiver.removeAgent("agent-1")
    expect(receiver.getHealth("agent-1")).toBeUndefined()
  })

  it("returns all health records", () => {
    const receiver = new HeartbeatReceiver()
    const now = new Date()
    receiver.recordHeartbeat(makeHeartbeat("agent-1", now))
    receiver.recordHeartbeat(makeHeartbeat("agent-2", now))

    const all = receiver.getAllHealth()
    expect(all).toHaveLength(2)
  })

  it("starts and stops monitoring", () => {
    const receiver = new HeartbeatReceiver()
    const callback = vi.fn()

    receiver.startMonitoring(callback)
    receiver.stopMonitoring()

    // Advance past heartbeat interval — callback should NOT fire
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
    expect(callback).not.toHaveBeenCalled()
  })

  it("monitoring fires callback for unhealthy agents", () => {
    const receiver = new HeartbeatReceiver()
    const callback = vi.fn()
    const t0 = new Date()

    receiver.recordHeartbeat(makeHeartbeat("agent-1", t0))
    receiver.startMonitoring(callback)

    // Advance past timeout
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS)

    expect(callback).toHaveBeenCalled()
    receiver.stopMonitoring()
  })
})

// ---------------------------------------------------------------------------
// K8s probe helpers
// ---------------------------------------------------------------------------

describe("isLivenessHealthy", () => {
  it("returns true for all states except TERMINATED", () => {
    expect(isLivenessHealthy("BOOTING")).toBe(true)
    expect(isLivenessHealthy("HYDRATING")).toBe(true)
    expect(isLivenessHealthy("READY")).toBe(true)
    expect(isLivenessHealthy("EXECUTING")).toBe(true)
    expect(isLivenessHealthy("DRAINING")).toBe(true)
  })

  it("returns false for TERMINATED", () => {
    expect(isLivenessHealthy("TERMINATED")).toBe(false)
  })
})

describe("isReadinessHealthy", () => {
  it("returns true only for READY and EXECUTING", () => {
    expect(isReadinessHealthy("READY")).toBe(true)
    expect(isReadinessHealthy("EXECUTING")).toBe(true)
  })

  it("returns false for non-ready states", () => {
    expect(isReadinessHealthy("BOOTING")).toBe(false)
    expect(isReadinessHealthy("HYDRATING")).toBe(false)
    expect(isReadinessHealthy("DRAINING")).toBe(false)
    expect(isReadinessHealthy("TERMINATED")).toBe(false)
  })
})
