import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import { AgentLifecycleManager, type LifecycleManagerDeps } from "../lifecycle/manager.js"
import type { LifecycleTransitionEvent } from "../lifecycle/state-machine.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockDb() {
  const mockResult = {
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
  }

  const mockChain = {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: mockResult.executeTakeFirst,
    execute: mockResult.execute,
  }

  const db = {
    selectFrom: vi.fn().mockReturnValue(mockChain),
    updateTable: vi.fn().mockReturnValue(mockChain),
    _mockChain: mockChain,
    _mockResult: mockResult,
  }

  return db as unknown as Kysely<Database> & {
    _mockChain: typeof mockChain
    _mockResult: typeof mockResult
  }
}

function makeMockDeployer() {
  return {
    deployAgent: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    getAgentStatus: vi.fn().mockResolvedValue(null),
    listAgents: vi.fn().mockResolvedValue([]),
  } as unknown as AgentDeployer & {
    deployAgent: ReturnType<typeof vi.fn>
    deleteAgent: ReturnType<typeof vi.fn>
  }
}

function configureDbForBoot(db: ReturnType<typeof makeMockDb>) {
  let callCount = 0
  db._mockResult.executeTakeFirst.mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      return {
        checkpoint: { step: 0 },
        checkpoint_crc: 123,
        status: "RUNNING",
        attempt: 1,
        payload: { task: "test task" },
      }
    }
    return {
      id: "agent-1",
      name: "Test Agent",
      slug: "test-agent",
      role: "devops",
      description: "A test agent",
      model_config: {},
      skill_config: {},
      resource_limits: {},
    }
  })
}

// ---------------------------------------------------------------------------
// Quarantine / Release tests
// ---------------------------------------------------------------------------

describe("AgentLifecycleManager quarantine/release", () => {
  let db: ReturnType<typeof makeMockDb>
  let deployer: ReturnType<typeof makeMockDeployer>
  let manager: AgentLifecycleManager
  let events: LifecycleTransitionEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    db = makeMockDb()
    deployer = makeMockDeployer()
    events = []

    manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: deployer as unknown as AgentDeployer,
      onLifecycleEvent: (event) => events.push(event),
    } satisfies LifecycleManagerDeps)
  })

  afterEach(() => {
    manager.shutdown()
    vi.useRealTimers()
  })

  it("quarantine transitions EXECUTING → QUARANTINED and fails the running job", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    expect(manager.getAgentState("agent-1")).toBe("EXECUTING")

    await manager.quarantine("agent-1", "3 consecutive failures")

    expect(manager.getAgentState("agent-1")).toBe("QUARANTINED")

    // Should have called updateTable twice: once for job (FAILED), once for agent (QUARANTINED)
    const updateCalls = (db.updateTable as ReturnType<typeof vi.fn>).mock.calls
    expect(updateCalls.length).toBeGreaterThanOrEqual(2)
    expect(updateCalls.some((c: string[]) => c[0] === "job")).toBe(true)
    expect(updateCalls.some((c: string[]) => c[0] === "agent")).toBe(true)
  })

  it("quarantine emits lifecycle transition event", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    const eventsBefore = events.length
    await manager.quarantine("agent-1", "too many failures")

    const quarantineEvent = events.slice(eventsBefore).find((e) => e.to === "QUARANTINED")
    expect(quarantineEvent).toBeDefined()
    expect(quarantineEvent!.from).toBe("EXECUTING")
    expect(quarantineEvent!.reason).toBe("too many failures")
  })

  it("quarantine throws if agent is not in valid source state", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    // Agent is in READY state, not EXECUTING or DEGRADED
    await expect(manager.quarantine("agent-1", "bad")).rejects.toThrow(
      "Invalid lifecycle transition",
    )
  })

  it("quarantine throws if agent is not managed", async () => {
    await expect(manager.quarantine("unknown-agent", "reason")).rejects.toThrow("not managed")
  })

  it("release transitions QUARANTINED → DRAINING", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    await manager.quarantine("agent-1", "failures")

    expect(manager.getAgentState("agent-1")).toBe("QUARANTINED")

    await manager.release("agent-1")

    expect(manager.getAgentState("agent-1")).toBe("DRAINING")
  })

  it("release restores DB agent status to ACTIVE", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    await manager.quarantine("agent-1", "failures")

    // Reset mock to track release calls
    ;(db.updateTable as ReturnType<typeof vi.fn>).mockClear()
    db._mockChain.set.mockClear()

    await manager.release("agent-1")

    const updateCalls = (db.updateTable as ReturnType<typeof vi.fn>).mock.calls
    expect(updateCalls.some((c: string[]) => c[0] === "agent")).toBe(true)
  })

  it("release with resetCrashDetector clears crash history", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    // Record a crash so crash detector has state
    manager.crashDetector.recordCrash("agent-1")
    expect(manager.crashDetector.getCrashRecord("agent-1")).toBeDefined()

    // Need a fresh boot to get back to EXECUTING → QUARANTINED path
    // First clean up the terminated agent from the crash
    vi.advanceTimersByTime(61_000)
    let bootCallCount = 0
    db._mockResult.executeTakeFirst.mockImplementation(() => {
      bootCallCount++
      if (bootCallCount === 1) {
        return {
          checkpoint: { step: 0 },
          checkpoint_crc: 123,
          status: "RUNNING",
          attempt: 1,
          payload: { task: "test" },
        }
      }
      return {
        id: "agent-1",
        name: "Test Agent",
        slug: "test-agent",
        role: "devops",
        description: null,
        model_config: {},
        skill_config: {},
        resource_limits: {},
      }
    })
    await manager.boot("agent-1", "job-2")
    manager.run("agent-1", "job-2")
    await manager.quarantine("agent-1", "test")

    await manager.release("agent-1", true)

    expect(manager.crashDetector.getCrashRecord("agent-1")).toBeUndefined()
  })

  it("release throws if agent is not in QUARANTINED state", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    // release() should reject if not in QUARANTINED state
    await expect(manager.release("agent-1")).rejects.toThrow("not in QUARANTINED state")
  })
})
