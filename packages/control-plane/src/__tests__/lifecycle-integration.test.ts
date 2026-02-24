import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Kysely } from "kysely"

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
  // First call: loadCheckpoint (selectFrom("job"))
  // Second call: loadIdentity (selectFrom("agent"))
  let callCount = 0
  db._mockResult.executeTakeFirst.mockImplementation(() => {
    callCount++
    if (callCount === 1) {
      // Checkpoint query
      return {
        checkpoint: { step: 0 },
        checkpoint_crc: 123,
        status: "RUNNING",
        attempt: 1,
        payload: { task: "test task" },
      }
    }
    // Identity query
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
// Integration test: boot → run → drain lifecycle
// ---------------------------------------------------------------------------

describe("AgentLifecycleManager integration", () => {
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

  it("boot → run → drain lifecycle", async () => {
    configureDbForBoot(db)

    // Boot
    const ctx = await manager.boot("agent-1", "job-1")
    expect(ctx.stateMachine.state).toBe("READY")
    expect(ctx.hydration).not.toBeNull()
    expect(ctx.hydration!.identity.name).toBe("Test Agent")

    // Verify transition events: BOOTING → HYDRATING → READY
    expect(events).toHaveLength(2)
    expect(events[0]!.from).toBe("BOOTING")
    expect(events[0]!.to).toBe("HYDRATING")
    expect(events[1]!.from).toBe("HYDRATING")
    expect(events[1]!.to).toBe("READY")

    // Run
    manager.run("agent-1", "job-1")
    expect(ctx.stateMachine.state).toBe("EXECUTING")
    expect(events).toHaveLength(3)
    expect(events[2]!.to).toBe("EXECUTING")

    // Drain
    await manager.drain("agent-1", "Test drain")
    expect(events).toHaveLength(5)
    expect(events[3]!.to).toBe("DRAINING")
    expect(events[4]!.to).toBe("TERMINATED")

    // Agent is cleaned up
    expect(manager.getAgentState("agent-1")).toBeUndefined()
    expect(manager.activeAgentCount).toBe(0)
  })

  it("boot fails if agent is in crash cooldown", async () => {
    manager.crashDetector.recordCrash("agent-1")

    await expect(manager.boot("agent-1", "job-1")).rejects.toThrow("crash cooldown")
  })

  it("crash records crash and cleans up", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    manager.crash("agent-1", new Error("OOM kill"))

    expect(manager.getAgentState("agent-1")).toBeUndefined()
    expect(manager.crashDetector.getCrashRecord("agent-1")).toBeDefined()
    expect(manager.crashDetector.getCrashRecord("agent-1")!.crashCount).toBe(1)
  })

  it("recover re-boots from checkpoint after crash", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    manager.crash("agent-1", new Error("test crash"))

    // Wait for cooldown to expire (1 minute)
    vi.advanceTimersByTime(61_000)

    // Reset call count for new boot
    let callCount = 0
    db._mockResult.executeTakeFirst.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return {
          checkpoint: { step: 3 },
          checkpoint_crc: 456,
          status: "RUNNING",
          attempt: 2,
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

    const ctx = await manager.recover("agent-1", "job-1")
    expect(ctx.stateMachine.state).toBe("READY")
    expect(ctx.hydration!.checkpoint.checkpoint).toEqual({ step: 3 })
  })

  it("pause updates job status without changing lifecycle state", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    db._mockResult.execute.mockResolvedValue({ numUpdatedRows: 1n })

    await manager.pause("agent-1")

    // Lifecycle state stays EXECUTING (pause is job-level)
    expect(manager.getAgentState("agent-1")).toBe("EXECUTING")
  })

  it("resume updates job status back to RUNNING", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    db._mockResult.execute.mockResolvedValue({ numUpdatedRows: 1n })

    await manager.pause("agent-1")
    await manager.resume("agent-1")

    expect(manager.getAgentState("agent-1")).toBe("EXECUTING")
  })

  it("terminate from any state", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")

    // Terminate from READY state (goes READY → DRAINING → TERMINATED)
    await manager.terminate("agent-1", "Manual termination")

    expect(manager.getAgentState("agent-1")).toBeUndefined()
    expect(deployer.deleteAgent).toHaveBeenCalled()
  })

  it("scaleToZero only affects READY agents", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")

    // Agent is in READY state — should be terminated
    await manager.scaleToZero("agent-1")
    expect(manager.getAgentState("agent-1")).toBeUndefined()
  })

  it("scaleToZero does not affect EXECUTING agents", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    // Agent is EXECUTING — scaleToZero should not terminate it
    await manager.scaleToZero("agent-1")
    expect(manager.getAgentState("agent-1")).toBe("EXECUTING")
  })

  it("handleHeartbeat updates health and idle tracker", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")

    manager.handleHeartbeat({
      type: "heartbeat",
      timestamp: new Date().toISOString(),
      agentId: "agent-1",
      jobId: "job-1",
      podName: "pod-agent-1",
      lifecycleState: "EXECUTING",
      currentStep: 1,
      metrics: {
        heapUsedMb: 128,
        uptimeSeconds: 60,
        stepsCompleted: 1,
        llmCallsTotal: 1,
        toolCallsTotal: 0,
      },
    })

    const health = manager.heartbeatReceiver.getHealth("agent-1")
    expect(health).toBeDefined()
    expect(health!.healthStatus).toBe("HEALTHY")
  })

  it("hydration failure transitions to TERMINATED", async () => {
    db._mockResult.executeTakeFirst.mockResolvedValue(null)

    await expect(manager.boot("agent-1", "job-1")).rejects.toThrow("Job not found")
    expect(manager.getAgentState("agent-1")).toBeUndefined()
  })

  it("drain rejects if agent is not in drainable state", async () => {
    configureDbForBoot(db)
    await manager.boot("agent-1", "job-1")
    manager.run("agent-1", "job-1")
    await manager.drain("agent-1")

    // Agent is now TERMINATED — drain again should fail
    await expect(manager.drain("agent-1")).rejects.toThrow("not managed")
  })
})
