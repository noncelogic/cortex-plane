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

function configureDbForIdentityOnly(db: ReturnType<typeof makeMockDb>) {
  db._mockResult.executeTakeFirst.mockResolvedValue({
    id: "agent-1",
    name: "Test Agent",
    slug: "test-agent",
    role: "devops",
    description: "A test agent",
    model_config: {},
    skill_config: {},
    resource_limits: {},
  })
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

describe("AgentLifecycleManager — quarantine", () => {
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

  it("quarantines an EXECUTING agent and cancels running job", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    db._mockResult.execute.mockResolvedValue({ numUpdatedRows: 1n })

    await manager.quarantine("agent-1", "Suspicious behavior detected")

    expect(manager.getAgentState("agent-1")).toBe("QUARANTINED")

    // Verify job was cancelled (status set to FAILED)
    expect(db.updateTable).toHaveBeenCalled()
  })

  it("quarantines a READY agent without cancelling jobs", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")

    await manager.quarantine("agent-1", "Maintenance window")

    expect(manager.getAgentState("agent-1")).toBe("QUARANTINED")
  })

  it("returns error when quarantining already-quarantined agent", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    await manager.quarantine("agent-1", "First quarantine")

    await expect(manager.quarantine("agent-1", "Second quarantine")).rejects.toThrow(
      "already quarantined",
    )
  })

  it("emits QUARANTINED transition event", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    events.length = 0

    await manager.quarantine("agent-1", "Test reason")

    expect(events).toHaveLength(1)
    expect(events[0]!.from).toBe("READY")
    expect(events[0]!.to).toBe("QUARANTINED")
    expect(events[0]!.reason).toBe("Test reason")
  })

  it("rejects quarantine from invalid states", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    await manager.drain("agent-1")

    // Agent is now TERMINATED and cleaned up
    await expect(manager.quarantine("agent-1", "Too late")).rejects.toThrow("not managed")
  })
})

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

describe("AgentLifecycleManager — release", () => {
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

  it("releases a quarantined agent through full re-boot cycle", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    await manager.quarantine("agent-1", "Test quarantine")

    // Reset mock for re-boot
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
        description: null,
        model_config: {},
        skill_config: {},
        resource_limits: {},
      }
    })

    const ctx = await manager.release("agent-1")

    expect(ctx.stateMachine.state).toBe("READY")
    expect(manager.getAgentState("agent-1")).toBe("READY")
  })

  it("release transitions through DRAINING → TERMINATED → re-boot", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    await manager.quarantine("agent-1", "Test")
    events.length = 0

    // Reset mock for re-boot
    let callCount = 0
    db._mockResult.executeTakeFirst.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return {
          checkpoint: { step: 0 },
          checkpoint_crc: 123,
          status: "RUNNING",
          attempt: 1,
          payload: {},
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

    await manager.release("agent-1")

    // Events: QUARANTINED→DRAINING, DRAINING→TERMINATED, BOOTING→HYDRATING, HYDRATING→READY
    expect(events).toHaveLength(4)
    expect(events[0]!.from).toBe("QUARANTINED")
    expect(events[0]!.to).toBe("DRAINING")
    expect(events[1]!.from).toBe("DRAINING")
    expect(events[1]!.to).toBe("TERMINATED")
    expect(events[2]!.from).toBe("BOOTING")
    expect(events[2]!.to).toBe("HYDRATING")
    expect(events[3]!.from).toBe("HYDRATING")
    expect(events[3]!.to).toBe("READY")
  })

  it("release with resetCircuitBreaker clears crash counters", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")

    // Record some crashes first
    manager.crashDetector.recordCrash("agent-1")
    expect(manager.crashDetector.getCrashRecord("agent-1")).toBeDefined()

    // Re-boot for quarantine (need fresh context since crash cleaned up)
    let callCount = 0
    db._mockResult.executeTakeFirst.mockImplementation(() => {
      callCount++
      if (callCount % 2 === 1) {
        return {
          checkpoint: { step: 0 },
          checkpoint_crc: 123,
          status: "RUNNING",
          attempt: 1,
          payload: {},
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

    // Advance past cooldown
    vi.advanceTimersByTime(61_000)

    await manager.boot("agent-1", "job-1")
    await manager.quarantine("agent-1", "Test")
    await manager.release("agent-1", { resetCircuitBreaker: true })

    expect(manager.crashDetector.getCrashRecord("agent-1")).toBeUndefined()
  })

  it("rejects release when agent is not quarantined", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")

    await expect(manager.release("agent-1")).rejects.toThrow("not in QUARANTINED state")
  })

  it("rejects release when agent is not managed", async () => {
    await expect(manager.release("unknown-agent")).rejects.toThrow("not managed")
  })
})

// ---------------------------------------------------------------------------
// Safe-mode boot
// ---------------------------------------------------------------------------

describe("AgentLifecycleManager — bootSafeMode", () => {
  let db: ReturnType<typeof makeMockDb>
  let deployer: ReturnType<typeof makeMockDeployer>
  let manager: AgentLifecycleManager
  let events: LifecycleTransitionEvent[]

  beforeEach(() => {
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
  })

  it("boots an agent in SAFE_MODE state", async () => {
    configureDbForIdentityOnly(db)

    const ctx = await manager.bootSafeMode("agent-1")

    expect(ctx.stateMachine.state).toBe("SAFE_MODE")
    expect(manager.getAgentState("agent-1")).toBe("SAFE_MODE")
  })

  it("loads identity but skips checkpoint and Qdrant", async () => {
    configureDbForIdentityOnly(db)

    const ctx = await manager.bootSafeMode("agent-1")

    expect(ctx.hydration).not.toBeNull()
    expect(ctx.hydration!.identity.name).toBe("Test Agent")
    expect(ctx.hydration!.checkpoint.checkpoint).toBeNull()
    expect(ctx.hydration!.qdrantContext).toBeNull()
    expect(ctx.hydration!.resolvedSkills).toBeNull()
  })

  it("uses provided jobId", async () => {
    configureDbForIdentityOnly(db)

    const ctx = await manager.bootSafeMode("agent-1", "custom-job-id")

    expect(ctx.jobId).toBe("custom-job-id")
  })

  it("generates default jobId when none provided", async () => {
    configureDbForIdentityOnly(db)

    const ctx = await manager.bootSafeMode("agent-1")

    expect(ctx.jobId).toBe("safe-mode-agent-1")
  })

  it("emits transition events BOOTING → HYDRATING → SAFE_MODE", async () => {
    configureDbForIdentityOnly(db)

    await manager.bootSafeMode("agent-1")

    expect(events).toHaveLength(2)
    expect(events[0]!.from).toBe("BOOTING")
    expect(events[0]!.to).toBe("HYDRATING")
    expect(events[1]!.from).toBe("HYDRATING")
    expect(events[1]!.to).toBe("SAFE_MODE")
  })

  it("transitions to TERMINATED on identity load failure", async () => {
    db._mockResult.executeTakeFirst.mockResolvedValue(null)

    await expect(manager.bootSafeMode("agent-1")).rejects.toThrow("Agent not found")
    expect(manager.getAgentState("agent-1")).toBeUndefined()
  })

  it("SAFE_MODE agent can be terminated", async () => {
    configureDbForIdentityOnly(db)

    await manager.bootSafeMode("agent-1")
    expect(manager.getAgentState("agent-1")).toBe("SAFE_MODE")

    await manager.terminate("agent-1", "Debug session complete")
    expect(manager.getAgentState("agent-1")).toBeUndefined()
  })
})
