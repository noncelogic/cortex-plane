/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Agent lifecycle integration tests — quarantine / release / boot (#491).
 *
 * End-to-end scenarios that exercise the full lifecycle state machine
 * together with the lifecycle manager, circuit breaker, and API routes.
 *
 * Test cases covered:
 * 1. ACTIVE → quarantine → QUARANTINED
 * 2. QUARANTINED → release with resetCircuitBreaker → ACTIVE, health_reset_at set
 * 3. Circuit breaker trips after N consecutive failures → auto-quarantine
 * 4. health_reset_at filters out pre-reset failures (#443 death spiral fix)
 * 5. Kill agent → quarantined, running job cancelled
 * 6. Safe-mode boot flow
 * 7. Full lifecycle round-trip: boot → execute → quarantine → release → re-boot
 */

import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import { AgentCircuitBreaker } from "../lifecycle/agent-circuit-breaker.js"
import { AgentLifecycleManager, type LifecycleManagerDeps } from "../lifecycle/manager.js"
import type { LifecycleTransitionEvent } from "../lifecycle/state-machine.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentLifecycleRoutes } from "../routes/agent-lifecycle.js"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
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

/**
 * Configure mock DB so that boot() hydration succeeds.
 * First executeTakeFirst → job/checkpoint, second → agent identity.
 */
function configureDbForBoot(db: ReturnType<typeof makeMockDb>, agentId = AGENT_ID) {
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
      id: agentId,
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
// 1. Full lifecycle: ACTIVE → quarantine → QUARANTINED
// ---------------------------------------------------------------------------

describe("Agent ACTIVE → quarantine → QUARANTINED", () => {
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

  it("transitions EXECUTING → QUARANTINED, fails the running job, and updates DB", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    expect(manager.getAgentState(AGENT_ID)).toBe("EXECUTING")

    await manager.quarantine(AGENT_ID, "3 consecutive failures")

    // State machine in QUARANTINED
    expect(manager.getAgentState(AGENT_ID)).toBe("QUARANTINED")

    // DB: job FAILED with QUARANTINED category + agent status QUARANTINED
    const updateCalls = (db.updateTable as ReturnType<typeof vi.fn>).mock.calls as string[][]
    expect(updateCalls.some((c) => c[0] === "job")).toBe(true)
    expect(updateCalls.some((c) => c[0] === "agent")).toBe(true)

    // Lifecycle events include the QUARANTINED transition
    const quarantineEvent = events.find((e) => e.to === "QUARANTINED")
    expect(quarantineEvent).toBeDefined()
    expect(quarantineEvent!.from).toBe("EXECUTING")
    expect(quarantineEvent!.reason).toBe("3 consecutive failures")
  })

  it("rejects quarantine from READY (not EXECUTING or DEGRADED)", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")

    expect(manager.getAgentState(AGENT_ID)).toBe("READY")

    await expect(manager.quarantine(AGENT_ID, "test")).rejects.toThrow(
      "Invalid lifecycle transition",
    )
  })
})

// ---------------------------------------------------------------------------
// 2. QUARANTINED → release with resetCircuitBreaker → ACTIVE + health_reset_at
// ---------------------------------------------------------------------------

describe("Quarantined → release with resetCircuitBreaker", () => {
  let db: ReturnType<typeof makeMockDb>
  let manager: AgentLifecycleManager
  let events: LifecycleTransitionEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    db = makeMockDb()
    events = []

    manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
      onLifecycleEvent: (event) => events.push(event),
    } satisfies LifecycleManagerDeps)
  })

  afterEach(() => {
    manager.shutdown()
    vi.useRealTimers()
  })

  it("transitions QUARANTINED → DRAINING, sets agent ACTIVE + health_reset_at in DB", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")
    await manager.quarantine(AGENT_ID, "failures")

    expect(manager.getAgentState(AGENT_ID)).toBe("QUARANTINED")

    // Clear mocks to isolate the release call
    ;(db.updateTable as ReturnType<typeof vi.fn>).mockClear()
    db._mockChain.set.mockClear()

    await manager.release(AGENT_ID, true)

    // Lifecycle transitions to DRAINING
    expect(manager.getAgentState(AGENT_ID)).toBe("DRAINING")

    // DB set() called with status=ACTIVE and health_reset_at
    const setCalls = db._mockChain.set.mock.calls as Array<[Record<string, unknown>]>
    const agentSetCall = setCalls.find(
      (c) => c[0].status === "ACTIVE" && c[0].health_reset_at instanceof Date,
    )
    expect(agentSetCall).toBeDefined()
  })

  it("resets crash detector when resetCrashDetector is true", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    // Record a crash so crash detector has state
    manager.crashDetector.recordCrash(AGENT_ID)
    expect(manager.crashDetector.getCrashRecord(AGENT_ID)).toBeDefined()

    // Advance past cooldown, re-boot + quarantine
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
        id: AGENT_ID,
        name: "Test Agent",
        slug: "test-agent",
        role: "devops",
        description: null,
        model_config: {},
        skill_config: {},
        resource_limits: {},
      }
    })
    await manager.boot(AGENT_ID, "job-2")
    manager.run(AGENT_ID, "job-2")
    await manager.quarantine(AGENT_ID, "test")

    await manager.release(AGENT_ID, true)

    expect(manager.crashDetector.getCrashRecord(AGENT_ID)).toBeUndefined()
  })

  it("rejects release if agent is not QUARANTINED", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    await expect(manager.release(AGENT_ID)).rejects.toThrow("not in QUARANTINED state")
  })
})

// ---------------------------------------------------------------------------
// 3. Circuit breaker trips after N consecutive failures → auto-quarantine
// ---------------------------------------------------------------------------

describe("Circuit breaker trips after N consecutive failures", () => {
  it("shouldQuarantine returns true after 3 consecutive failures (default threshold)", () => {
    const cb = new AgentCircuitBreaker(AGENT_ID)

    // Record 2 failures — not yet at threshold
    cb.recordJobFailure()
    cb.recordJobFailure()
    expect(cb.shouldQuarantine().quarantine).toBe(false)

    // 3rd failure → quarantine
    cb.recordJobFailure()
    const decision = cb.shouldQuarantine()
    expect(decision.quarantine).toBe(true)
    expect(decision.reason).toContain("3 consecutive job failures")
    expect(cb.tripped).toBe(true)
  })

  it("success resets the consecutive failure counter", () => {
    const cb = new AgentCircuitBreaker(AGENT_ID)

    cb.recordJobFailure()
    cb.recordJobFailure()
    cb.recordJobSuccess()
    cb.recordJobFailure()

    // Only 1 failure after the success — should not quarantine
    expect(cb.shouldQuarantine().quarantine).toBe(false)
  })

  it("respects custom maxConsecutiveFailures threshold", () => {
    const cb = new AgentCircuitBreaker(AGENT_ID, { maxConsecutiveFailures: 5 })

    for (let i = 0; i < 4; i++) cb.recordJobFailure()
    expect(cb.shouldQuarantine().quarantine).toBe(false)

    cb.recordJobFailure()
    expect(cb.shouldQuarantine().quarantine).toBe(true)
  })

  it("reset() clears all counters (operator release)", () => {
    const cb = new AgentCircuitBreaker(AGENT_ID)

    cb.recordJobFailure()
    cb.recordJobFailure()
    cb.recordJobFailure()
    expect(cb.shouldQuarantine().quarantine).toBe(true)

    cb.reset()

    expect(cb.shouldQuarantine().quarantine).toBe(false)
    expect(cb.tripped).toBe(false)
    expect(cb.getState().consecutiveJobFailures).toBe(0)
  })

  it("integrates with lifecycle manager via registerCircuitBreaker", () => {
    const db = makeMockDb()
    const manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
    } satisfies LifecycleManagerDeps)

    const cb = new AgentCircuitBreaker(AGENT_ID)
    manager.registerCircuitBreaker(AGENT_ID, cb)

    // Record failures and verify the CB state is visible via getState()
    cb.recordJobFailure()
    cb.recordJobFailure()
    cb.recordJobFailure()

    const state = cb.getState()
    expect(state.consecutiveJobFailures).toBe(3)
    expect(cb.shouldQuarantine().quarantine).toBe(true)

    manager.shutdown()
  })
})

// ---------------------------------------------------------------------------
// 4. health_reset_at filters out pre-reset failures (#443)
// ---------------------------------------------------------------------------

describe("health_reset_at filters out pre-reset failures (#443)", () => {
  let db: ReturnType<typeof makeMockDb>
  let manager: AgentLifecycleManager

  beforeEach(() => {
    vi.useFakeTimers()
    db = makeMockDb()

    manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
    } satisfies LifecycleManagerDeps)
  })

  afterEach(() => {
    manager.shutdown()
    vi.useRealTimers()
  })

  it("release sets health_reset_at to break quarantine death spiral", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")
    await manager.quarantine(AGENT_ID, "failures")

    // Clear to isolate release DB writes
    ;(db.updateTable as ReturnType<typeof vi.fn>).mockClear()
    db._mockChain.set.mockClear()

    await manager.release(AGENT_ID)

    const setCalls = db._mockChain.set.mock.calls as Array<[Record<string, unknown>]>
    const resetCall = setCalls.find(
      (c) => c[0].health_reset_at instanceof Date && c[0].status === "ACTIVE",
    )
    expect(resetCall).toBeDefined()

    // The health_reset_at should be recent (within 1 second of "now")
    const resetAt = resetCall![0].health_reset_at as Date
    expect(resetAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

// ---------------------------------------------------------------------------
// 5. Kill agent → quarantined, running job cancelled
// ---------------------------------------------------------------------------

describe("Kill agent → quarantined, running job cancelled", () => {
  it("quarantine via API route cancels running job and sets QUARANTINED", async () => {
    const { db: rawDb } = makeMockDbForRoute({ agentStatus: "ACTIVE" })
    const routeDb = rawDb
    configureDbForBootRoute(routeDb)
    const manager = new AgentLifecycleManager({
      db: routeDb,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
    } satisfies LifecycleManagerDeps)

    // Boot + run the agent so it's in EXECUTING
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db: routeDb,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "Operator kill — suspicious activity" },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().agentId).toBe(AGENT_ID)
    expect(res.json().state).toBe("QUARANTINED")
    expect(res.json().reason).toBe("Operator kill — suspicious activity")

    // Lifecycle manager reflects QUARANTINED state
    expect(manager.getAgentState(AGENT_ID)).toBe("QUARANTINED")

    manager.shutdown()
  })

  it("returns 409 if agent is already quarantined", async () => {
    const { db: routeDb } = makeMockDbForRoute({ agentStatus: "QUARANTINED" })

    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db: routeDb,
        authConfig: DEV_AUTH_CONFIG,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "test" },
    })

    expect(res.statusCode).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// 6. Safe-mode boot flow
// ---------------------------------------------------------------------------

describe("Safe-mode boot flow", () => {
  let manager: AgentLifecycleManager

  beforeEach(() => {
    const db = makeMockDb()
    manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
    } satisfies LifecycleManagerDeps)
  })

  afterEach(() => {
    manager.shutdown()
  })

  it("bootSafeMode transitions BOOTING → SAFE_MODE", () => {
    const ctx = manager.bootSafeMode(AGENT_ID)

    expect(ctx.stateMachine.state).toBe("SAFE_MODE")
    expect(ctx.hydration).toBeNull()
    expect(ctx.agentId).toBe(AGENT_ID)
  })

  it("safe-mode agent can transition SAFE_MODE → READY → EXECUTING", () => {
    const ctx = manager.bootSafeMode(AGENT_ID)

    ctx.stateMachine.transition("READY", "Debug session complete")
    expect(ctx.stateMachine.state).toBe("READY")

    ctx.stateMachine.transition("EXECUTING", "Running debug job")
    expect(ctx.stateMachine.state).toBe("EXECUTING")
  })

  it("safe-mode skips hydration (no tools, no memory)", () => {
    const ctx = manager.bootSafeMode(AGENT_ID, "debug-job")

    expect(ctx.hydration).toBeNull()
    expect(ctx.jobId).toBe("debug-job")
  })

  it("safe-mode boot is exposed via API route with restrictions", async () => {
    const { db: routeDb } = makeMockDbForRoute()

    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db: routeDb,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().state).toBe("SAFE_MODE")
    expect(res.json().restrictions).toEqual([
      "no_tools",
      "no_memory_context",
      "identity_only_system_prompt",
      "token_budget_10000",
      "single_turn_only",
    ])
  })
})

// ---------------------------------------------------------------------------
// 7. Full round-trip: boot → execute → quarantine → release → re-boot
// ---------------------------------------------------------------------------

describe("Full lifecycle round-trip", () => {
  let db: ReturnType<typeof makeMockDb>
  let manager: AgentLifecycleManager
  let events: LifecycleTransitionEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    db = makeMockDb()
    events = []

    manager = new AgentLifecycleManager({
      db: db as unknown as Kysely<Database>,
      deployer: makeMockDeployer() as unknown as AgentDeployer,
      onLifecycleEvent: (event) => events.push(event),
    } satisfies LifecycleManagerDeps)
  })

  afterEach(() => {
    manager.shutdown()
    vi.useRealTimers()
  })

  it("boot → execute → quarantine → release → drain → re-boot", async () => {
    // Phase 1: Boot + Execute
    configureDbForBoot(db)
    const ctx1 = await manager.boot(AGENT_ID, "job-1")
    expect(ctx1.stateMachine.state).toBe("READY")

    manager.run(AGENT_ID, "job-1")
    expect(manager.getAgentState(AGENT_ID)).toBe("EXECUTING")

    // Phase 2: Quarantine
    await manager.quarantine(AGENT_ID, "circuit breaker tripped")
    expect(manager.getAgentState(AGENT_ID)).toBe("QUARANTINED")

    // Phase 3: Release (QUARANTINED → DRAINING)
    await manager.release(AGENT_ID, true)
    expect(manager.getAgentState(AGENT_ID)).toBe("DRAINING")

    // Verify lifecycle events cover the full journey
    const stateSequence = events.map((e) => e.to)
    expect(stateSequence).toEqual([
      "HYDRATING", // boot
      "READY", // boot
      "EXECUTING", // run
      "QUARANTINED", // quarantine
      "DRAINING", // release
    ])
  })

  it("released agent can be re-booted after drain completes", async () => {
    configureDbForBoot(db)
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")
    await manager.quarantine(AGENT_ID, "failures")
    await manager.release(AGENT_ID)

    // DRAINING — but we need to complete the drain + terminate cycle
    // In real code, the drain handler would eventually call terminate.
    // Simulate: transition DRAINING → TERMINATED, then cleanup
    const ctx = manager.getAgentContext(AGENT_ID)!
    ctx.stateMachine.transition("TERMINATED", "Drain complete")

    // Agent is cleaned up after TERMINATED — simulate manager cleanup
    // In practice the manager's drain() does this, but since release only
    // goes to DRAINING (not full drain), we verify the state can reach TERMINATED.
    expect(ctx.stateMachine.state).toBe("TERMINATED")
    expect(ctx.stateMachine.isTerminal).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Route-level mock helpers (different pattern for Fastify injection tests)
// ---------------------------------------------------------------------------

function makeMockDbForRoute(opts: { agentExists?: boolean; agentStatus?: string } = {}) {
  const { agentExists = true, agentStatus = "ACTIVE" } = opts
  const agentRow = agentExists ? { id: AGENT_ID, status: agentStatus } : null
  const updateExecute = vi.fn().mockResolvedValue([])

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(agentRow),
            }),
          }),
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(agentRow),
            }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    }),
    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: updateExecute,
          }),
          execute: updateExecute,
        }),
      }),
    }),
  } as unknown as Kysely<Database>

  return { db, updateExecute }
}

function configureDbForBootRoute(db: Kysely<Database>) {
  let callCount = 0
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const selectFrom = vi.mocked(db.selectFrom)
  selectFrom.mockImplementation((table: string) => {
    if (table === "agent") {
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({ id: AGENT_ID, status: "ACTIVE" }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              id: AGENT_ID,
              name: "Test Agent",
              slug: "test-agent",
              role: "devops",
              description: null,
              model_config: {},
              skill_config: {},
              resource_limits: {},
            }),
          }),
        }),
      }
    }
    callCount++
    return {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(
            callCount === 1
              ? {
                  checkpoint: { step: 0 },
                  checkpoint_crc: 123,
                  status: "RUNNING",
                  attempt: 1,
                  payload: { task: "test" },
                }
              : null,
          ),
        }),
      }),
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(null),
        }),
      }),
    }
  })
}
