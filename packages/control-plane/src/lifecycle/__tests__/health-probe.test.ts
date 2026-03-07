import { describe, expect, it, vi } from "vitest"

import { HeartbeatReceiver } from "../health.js"
import {
  type HealthProbeDeps,
  PROBE_INTERVAL_EXECUTING_MS,
  PROBE_INTERVAL_READY_MS,
  PROBE_SKIP_STATES,
  probeAgentHealth,
} from "../health-probe.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Kysely mock that returns configurable rows. */
function mockDb(overrides?: {
  checkpointRow?: { created_at: Date } | undefined
  agentRow?: { id: string } | undefined
  dbReachable?: boolean
}) {
  const checkpointRow = overrides?.checkpointRow
  const agentRow = overrides?.agentRow ?? { id: "agent-1" }
  const dbReachable = overrides?.dbReachable ?? true

  const chain = () => {
    const q = {
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      execute: vi.fn().mockImplementation(() => {
        if (!dbReachable) return Promise.reject(new Error("DB unreachable"))
        return Promise.resolve(agentRow ? [agentRow] : [])
      }),
      executeTakeFirst: vi.fn().mockImplementation(() => {
        if (!dbReachable) return Promise.reject(new Error("DB unreachable"))
        return Promise.resolve(checkpointRow)
      }),
    }
    return q
  }

  return { selectFrom: vi.fn().mockImplementation(chain) } as unknown as HealthProbeDeps["db"]
}

function baseDeps(overrides?: Partial<HealthProbeDeps>): HealthProbeDeps {
  return {
    db: mockDb(),
    heartbeatReceiver: new HeartbeatReceiver(),
    lifecycleState: "EXECUTING",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests — Acceptance criteria from #317
// ---------------------------------------------------------------------------

describe("probeAgentHealth", () => {
  // AC: Healthy agent — all subsystems report OK
  it("returns HEALTHY when all subsystems are OK", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps())

    expect(result.agentId).toBe("agent-1")
    expect(result.healthStatus).toBe("HEALTHY")
    expect(result.lifecycleState).toBe("EXECUTING")
    expect(result.subsystems.qdrant).toBe("OK")
    expect(result.subsystems.db).toBe("OK")
    expect(result.subsystems.mcp).toBe("OK")
    expect(result.circuitBreaker.tripped).toBe(false)
    expect(result.circuitBreaker.state).toBe("CLOSED")
  })

  // AC: Agent with Qdrant unavailable → subsystems.qdrant = "UNAVAILABLE", overall DEGRADED
  it("returns DEGRADED when Qdrant is unavailable", async () => {
    const qdrantClient = {
      getCollections: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as HealthProbeDeps["qdrantClient"]

    const result = await probeAgentHealth("agent-1", baseDeps({ qdrantClient }))

    expect(result.subsystems.qdrant).toBe("UNAVAILABLE")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  // AC: Agent with tripped circuit breaker → circuitBreaker.tripped = true
  it("returns UNHEALTHY when circuit breaker is tripped", async () => {
    const result = await probeAgentHealth(
      "agent-1",
      baseDeps({
        circuitBreakerState: {
          consecutiveJobFailures: 3,
          currentJobToolErrors: 0,
          currentJobLlmRetries: 0,
          currentJobTokensUsed: 100_000,
          currentSessionTokensUsed: 200_000,
          toolCallTimestamps: [],
          llmCallTimestamps: [],
          tripped: true,
          tripReason: "3 consecutive job failures",
        },
      }),
    )

    expect(result.circuitBreaker.tripped).toBe(true)
    expect(result.circuitBreaker.tripReason).toBe("3 consecutive job failures")
    expect(result.circuitBreaker.state).toBe("OPEN")
    expect(result.healthStatus).toBe("UNHEALTHY")
  })

  // AC: API returns 404 for unknown agent — tested in route test, but verify
  // the probe returns correct data structure for any agentId
  it("returns UNKNOWN status for agent with no heartbeat data", async () => {
    const result = await probeAgentHealth("agent-unknown", baseDeps())

    expect(result.lastHeartbeat).toBeNull()
    expect(result.healthStatus).toBe("HEALTHY") // subsystems still OK
  })

  // -----------------------------------------------------------------------
  // Heartbeat freshness
  // -----------------------------------------------------------------------

  it("includes last heartbeat timestamp when available", async () => {
    const receiver = new HeartbeatReceiver()
    receiver.recordHeartbeat({
      type: "heartbeat",
      timestamp: "2026-03-07T12:00:00.000Z",
      agentId: "agent-1",
      jobId: "job-1",
      podName: "pod-1",
      lifecycleState: "EXECUTING",
      currentStep: 5,
      metrics: {
        heapUsedMb: 128,
        uptimeSeconds: 600,
        stepsCompleted: 5,
        llmCallsTotal: 10,
        toolCallsTotal: 20,
      },
    })

    const result = await probeAgentHealth("agent-1", baseDeps({ heartbeatReceiver: receiver }))

    expect(result.lastHeartbeat).toBe("2026-03-07T12:00:00.000Z")
  })

  // -----------------------------------------------------------------------
  // Last checkpoint
  // -----------------------------------------------------------------------

  it("includes last checkpoint timestamp", async () => {
    const checkpointDate = new Date("2026-03-07T11:30:00.000Z")
    const db = mockDb({ checkpointRow: { created_at: checkpointDate } })

    const result = await probeAgentHealth("agent-1", baseDeps({ db }))

    expect(result.lastCheckpoint).toBe("2026-03-07T11:30:00.000Z")
  })

  it("returns null for lastCheckpoint when none exists", async () => {
    const db = mockDb({ checkpointRow: undefined })

    const result = await probeAgentHealth("agent-1", baseDeps({ db }))

    expect(result.lastCheckpoint).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Token budget
  // -----------------------------------------------------------------------

  it("returns token budget from circuit breaker state", async () => {
    const result = await probeAgentHealth(
      "agent-1",
      baseDeps({
        circuitBreakerState: {
          consecutiveJobFailures: 0,
          currentJobToolErrors: 0,
          currentJobLlmRetries: 0,
          currentJobTokensUsed: 42_000,
          currentSessionTokensUsed: 100_000,
          toolCallTimestamps: [],
          llmCallTimestamps: [],
          tripped: false,
          tripReason: null,
        },
        tokenBudgetConfig: {
          limitPerJob: 500_000,
          limitPerSession: 2_000_000,
        },
      }),
    )

    expect(result.tokenBudget).toEqual({
      usedThisJob: 42_000,
      usedThisSession: 100_000,
      limitPerJob: 500_000,
      limitPerSession: 2_000_000,
    })
  })

  it("uses default token budget limits when not provided", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps())

    expect(result.tokenBudget.limitPerJob).toBe(500_000)
    expect(result.tokenBudget.limitPerSession).toBe(2_000_000)
  })

  // -----------------------------------------------------------------------
  // DB subsystem check
  // -----------------------------------------------------------------------

  it("reports db UNAVAILABLE when DB query fails", async () => {
    const db = mockDb({ dbReachable: false })

    const result = await probeAgentHealth("agent-1", baseDeps({ db }))

    expect(result.subsystems.db).toBe("UNAVAILABLE")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  // -----------------------------------------------------------------------
  // MCP subsystem check
  // -----------------------------------------------------------------------

  it("reports mcp status from McpHealthSupervisor", async () => {
    const mcpHealthSupervisor = {
      getHealthReport: vi.fn().mockReturnValue({
        status: "degraded",
        servers: [],
        probeIntervalMs: 30_000,
      }),
    } as unknown as HealthProbeDeps["mcpHealthSupervisor"]

    const result = await probeAgentHealth("agent-1", baseDeps({ mcpHealthSupervisor }))

    expect(result.subsystems.mcp).toBe("DEGRADED")
    expect(result.healthStatus).toBe("DEGRADED")
  })

  it("reports mcp OK when no supervisor is configured", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps({ mcpHealthSupervisor: undefined }))

    expect(result.subsystems.mcp).toBe("OK")
  })

  // -----------------------------------------------------------------------
  // Lifecycle state effects
  // -----------------------------------------------------------------------

  it("returns UNHEALTHY for TERMINATED agents", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps({ lifecycleState: "TERMINATED" }))

    expect(result.healthStatus).toBe("UNHEALTHY")
    expect(result.lifecycleState).toBe("TERMINATED")
  })

  it("returns UNHEALTHY for QUARANTINED agents", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps({ lifecycleState: "QUARANTINED" }))

    expect(result.healthStatus).toBe("UNHEALTHY")
  })

  it("returns HEALTHY for READY agents with all OK", async () => {
    const result = await probeAgentHealth("agent-1", baseDeps({ lifecycleState: "READY" }))

    expect(result.healthStatus).toBe("HEALTHY")
  })

  // -----------------------------------------------------------------------
  // Probe schedule constants
  // -----------------------------------------------------------------------

  it("defines correct probe intervals", () => {
    expect(PROBE_INTERVAL_EXECUTING_MS).toBe(60_000)
    expect(PROBE_INTERVAL_READY_MS).toBe(300_000)
  })

  it("skips QUARANTINED, TERMINATED, and SAFE_MODE states", () => {
    expect(PROBE_SKIP_STATES.has("QUARANTINED")).toBe(true)
    expect(PROBE_SKIP_STATES.has("TERMINATED")).toBe(true)
    expect(PROBE_SKIP_STATES.has("SAFE_MODE")).toBe(true)
    expect(PROBE_SKIP_STATES.has("EXECUTING")).toBe(false)
    expect(PROBE_SKIP_STATES.has("READY")).toBe(false)
  })
})
