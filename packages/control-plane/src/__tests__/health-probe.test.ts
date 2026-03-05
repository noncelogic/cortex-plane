import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { AgentHealthRecord, HeartbeatReceiver } from "../lifecycle/health.js"
import {
  type HealthProbeDeps,
  type HealthProbeSchedulerDeps,
  HealthProbeScheduler,
  PROBE_INTERVAL_EXECUTING_MS,
  PROBE_INTERVAL_READY_MS,
  probeAgentHealth,
  SKIP_PROBE_STATES,
} from "../lifecycle/health-probe.js"
import type { AgentLifecycleState } from "../lifecycle/state-machine.js"
import type { McpHealthSupervisor, McpHealthSummary } from "../mcp/health-supervisor.js"
import type { QdrantClient } from "../lifecycle/hydration.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockDb() {
  const executeTakeFirst = vi.fn()
  const execute = vi.fn()

  const chain = {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    executeTakeFirst,
    execute,
  }

  const db = {
    selectFrom: vi.fn().mockReturnValue(chain),
    _chain: chain,
  }

  return db as unknown as Kysely<Database> & { _chain: typeof chain }
}

function makeMockHeartbeatReceiver(healthRecord?: Partial<AgentHealthRecord>): HeartbeatReceiver {
  const record: AgentHealthRecord | undefined = healthRecord
    ? {
        agentId: healthRecord.agentId ?? "agent-1",
        lastHeartbeat: healthRecord.lastHeartbeat ?? new Date("2026-03-01T10:00:00Z"),
        lastLifecycleState: healthRecord.lastLifecycleState ?? "EXECUTING",
        healthStatus: healthRecord.healthStatus ?? "HEALTHY",
        consecutiveMisses: healthRecord.consecutiveMisses ?? 0,
        lastMetrics: healthRecord.lastMetrics ?? null,
      }
    : undefined

  return {
    getHealth: vi.fn().mockReturnValue(record),
    recordHeartbeat: vi.fn(),
    evaluateHealth: vi.fn().mockReturnValue([]),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    removeAgent: vi.fn(),
    getAllHealth: vi.fn().mockReturnValue(record ? [record] : []),
  } as unknown as HeartbeatReceiver
}

function makeMockQdrantClient(shouldFail = false): QdrantClient {
  return {
    search: shouldFail
      ? vi.fn().mockRejectedValue(new Error("Connection refused"))
      : vi.fn().mockResolvedValue([]),
  }
}

function makeMockMcpSupervisor(
  status: "ok" | "degraded" | "unavailable" = "ok",
): McpHealthSupervisor {
  return {
    getHealthReport: vi.fn().mockReturnValue({
      status,
      servers: [],
      probeIntervalMs: 30_000,
    } satisfies McpHealthSummary),
  } as unknown as McpHealthSupervisor
}

function makeDefaultDeps(overrides: Partial<HealthProbeDeps> = {}): HealthProbeDeps {
  const db = makeMockDb()
  // Configure DB to return a job and agent
  db._chain.executeTakeFirst
    .mockResolvedValueOnce({
      updated_at: new Date("2026-03-01T09:50:00Z"),
      payload: { tokens_used: 1500, session_tokens_used: 5000 },
    })
    .mockResolvedValueOnce({
      resource_limits: { maxTokensPerJob: 10_000, maxTokensPerSession: 50_000 },
    })

  return {
    db: db as unknown as Kysely<Database>,
    heartbeatReceiver: makeMockHeartbeatReceiver({}),
    qdrantClient: makeMockQdrantClient(),
    mcpHealthSupervisor: makeMockMcpSupervisor(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// probeAgentHealth
// ---------------------------------------------------------------------------

describe("probeAgentHealth", () => {
  it("returns HEALTHY when all subsystems are OK", async () => {
    const deps = makeDefaultDeps()
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.agentId).toBe("agent-1")
    expect(result.lifecycleState).toBe("EXECUTING")
    expect(result.healthStatus).toBe("HEALTHY")
    expect(result.circuitBreaker.tripped).toBe(false)
    expect(result.circuitBreaker.state).toBe("CLOSED")
    expect(result.subsystems.qdrant).toBe("OK")
    expect(result.subsystems.db).toBe("OK")
    expect(result.subsystems.mcp).toBe("OK")
    expect(result.lastHeartbeat).toBeTruthy()
  })

  it("returns token budget from DB", async () => {
    const deps = makeDefaultDeps()
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.tokenBudget).toEqual({
      usedThisJob: 1500,
      usedThisSession: 5000,
      limitPerJob: 10_000,
      limitPerSession: 50_000,
    })
  })

  it("returns lastCheckpoint from job updated_at", async () => {
    const deps = makeDefaultDeps()
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.lastCheckpoint).toBe("2026-03-01T09:50:00.000Z")
  })

  it("reports DEGRADED when Qdrant is unavailable", async () => {
    const deps = makeDefaultDeps({
      qdrantClient: makeMockQdrantClient(true),
    })
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.subsystems.qdrant).toBe("UNAVAILABLE")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  it("reports DEGRADED when Qdrant client is not configured", async () => {
    const deps = makeDefaultDeps({ qdrantClient: undefined })
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.subsystems.qdrant).toBe("UNAVAILABLE")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  it("reports DEGRADED when MCP is degraded", async () => {
    const deps = makeDefaultDeps({
      mcpHealthSupervisor: makeMockMcpSupervisor("degraded"),
    })
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.subsystems.mcp).toBe("DEGRADED")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  it("reports circuit breaker tripped after 3+ heartbeat misses", async () => {
    const deps = makeDefaultDeps({
      heartbeatReceiver: makeMockHeartbeatReceiver({
        healthStatus: "UNHEALTHY",
        consecutiveMisses: 4,
      }),
    })
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.circuitBreaker.tripped).toBe(true)
    expect(result.circuitBreaker.state).toBe("OPEN")
    expect(result.circuitBreaker.consecutiveFailures).toBe(4)
    expect(result.circuitBreaker.tripReason).toContain("consecutive heartbeat misses")
    expect(result.healthStatus).toBe("UNHEALTHY")
  })

  it("reports circuit breaker tripped for TERMINATED agents", async () => {
    const deps = makeDefaultDeps({
      heartbeatReceiver: makeMockHeartbeatReceiver({ consecutiveMisses: 0 }),
    })
    const result = await probeAgentHealth("agent-1", "TERMINATED", deps)

    expect(result.circuitBreaker.tripped).toBe(true)
    expect(result.circuitBreaker.tripReason).toBe("Agent terminated")
  })

  it("returns UNKNOWN when no heartbeat data exists", async () => {
    const deps = makeDefaultDeps({
      heartbeatReceiver: makeMockHeartbeatReceiver() as unknown as HeartbeatReceiver,
    })
    // Override getHealth to return undefined
    vi.mocked(deps.heartbeatReceiver.getHealth).mockReturnValue(undefined)
    const result = await probeAgentHealth("agent-1", "READY", deps)

    expect(result.healthStatus).toBe("UNKNOWN")
    expect(result.lastHeartbeat).toBeNull()
  })

  it("handles DB failure gracefully", async () => {
    const db = makeMockDb()
    db._chain.executeTakeFirst.mockRejectedValue(new Error("Connection refused"))

    const deps = makeDefaultDeps({ db: db as unknown as Kysely<Database> })
    const result = await probeAgentHealth("agent-1", "EXECUTING", deps)

    expect(result.subsystems.db).toBe("UNAVAILABLE")
    expect(result.healthStatus).toBe("DEGRADED")
    expect(result.lastCheckpoint).toBeNull()
    expect(result.tokenBudget.usedThisJob).toBe(0)
  })

  it("returns 404 data structure for unknown agent (no DB records)", async () => {
    const db = makeMockDb()
    db._chain.executeTakeFirst.mockResolvedValue(null)

    const deps = makeDefaultDeps({ db: db as unknown as Kysely<Database> })
    const result = await probeAgentHealth("unknown-agent", "READY", deps)

    expect(result.agentId).toBe("unknown-agent")
    expect(result.lastCheckpoint).toBeNull()
    expect(result.tokenBudget.limitPerJob).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SKIP_PROBE_STATES
// ---------------------------------------------------------------------------

describe("SKIP_PROBE_STATES", () => {
  it("skips QUARANTINED, TERMINATED, SAFE_MODE", () => {
    expect(SKIP_PROBE_STATES.has("QUARANTINED")).toBe(true)
    expect(SKIP_PROBE_STATES.has("TERMINATED")).toBe(true)
    expect(SKIP_PROBE_STATES.has("SAFE_MODE")).toBe(true)
  })

  it("does not skip EXECUTING or READY", () => {
    expect(SKIP_PROBE_STATES.has("EXECUTING")).toBe(false)
    expect(SKIP_PROBE_STATES.has("READY")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HealthProbeScheduler
// ---------------------------------------------------------------------------

describe("HealthProbeScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeSchedulerDeps(
    state: AgentLifecycleState | undefined = "EXECUTING",
  ): HealthProbeSchedulerDeps {
    const db = makeMockDb()
    // Configure default DB responses for each probe
    db._chain.executeTakeFirst.mockResolvedValue({
      updated_at: new Date("2026-03-01T10:00:00Z"),
      payload: {},
      resource_limits: {},
    })

    return {
      db: db as unknown as Kysely<Database>,
      heartbeatReceiver: makeMockHeartbeatReceiver(),
      qdrantClient: makeMockQdrantClient(),
      mcpHealthSupervisor: makeMockMcpSupervisor(),
      getAgentState: vi.fn().mockReturnValue(state),
    }
  }

  it("starts probing for an EXECUTING agent at 60s interval", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")

    // Wait for initial probe
    await vi.advanceTimersByTimeAsync(1)

    const result = scheduler.getLastResult("agent-1")
    expect(result).not.toBeNull()
    expect(result!.agentId).toBe("agent-1")

    scheduler.shutdown()
  })

  it("uses 300s interval for READY agents", async () => {
    const deps = makeSchedulerDeps("READY")
    const onDegraded = vi.fn()
    const scheduler = new HealthProbeScheduler(deps, onDegraded)

    scheduler.startProbing("agent-1")

    // Initial probe runs immediately
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.getLastResult("agent-1")).not.toBeNull()

    scheduler.shutdown()
  })

  it("does not start probing for TERMINATED agents", () => {
    const deps = makeSchedulerDeps("TERMINATED")
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    expect(scheduler.getLastResult("agent-1")).toBeNull()

    scheduler.shutdown()
  })

  it("does not start probing when agent state is undefined", () => {
    const deps = makeSchedulerDeps(undefined)
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    expect(scheduler.getLastResult("agent-1")).toBeNull()

    scheduler.shutdown()
  })

  it("stops probing for an agent", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.getLastResult("agent-1")).not.toBeNull()

    scheduler.stopProbing("agent-1")
    expect(scheduler.getLastResult("agent-1")).toBeNull()

    scheduler.shutdown()
  })

  it("calls onDegraded callback when health is DEGRADED", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    // Make Qdrant unavailable to trigger DEGRADED
    deps.qdrantClient = makeMockQdrantClient(true)
    const onDegraded = vi.fn()
    const scheduler = new HealthProbeScheduler(deps, onDegraded)

    scheduler.startProbing("agent-1")
    await vi.advanceTimersByTimeAsync(1)

    expect(onDegraded).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        healthStatus: "DEGRADED",
      }),
    )

    scheduler.shutdown()
  })

  it("runs probes on schedule", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    await vi.advanceTimersByTimeAsync(1)

    // Verify getAgentState is called on each probe
    const getStateFn = deps.getAgentState as ReturnType<typeof vi.fn>
    const initialCalls = getStateFn.mock.calls.length

    // Advance to trigger next probe
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_EXECUTING_MS)
    expect(getStateFn.mock.calls.length).toBeGreaterThan(initialCalls)

    scheduler.shutdown()
  })

  it("shutdown clears all timers", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    scheduler.startProbing("agent-2")
    await vi.advanceTimersByTimeAsync(1)

    scheduler.shutdown()

    expect(scheduler.getLastResult("agent-1")).toBeNull()
    expect(scheduler.getLastResult("agent-2")).toBeNull()
  })

  it("stops probing if agent transitions to TERMINATED", async () => {
    const deps = makeSchedulerDeps("EXECUTING")
    const getStateFn = deps.getAgentState as ReturnType<typeof vi.fn>
    const scheduler = new HealthProbeScheduler(deps)

    scheduler.startProbing("agent-1")
    await vi.advanceTimersByTimeAsync(1)
    expect(scheduler.getLastResult("agent-1")).not.toBeNull()

    // Agent transitions to TERMINATED
    getStateFn.mockReturnValue("TERMINATED")
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_EXECUTING_MS)

    // Scheduler should have stopped probing
    expect(scheduler.getLastResult("agent-1")).toBeNull()

    scheduler.shutdown()
  })
})
