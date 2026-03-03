import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  McpHealthSupervisor,
  circuitStateToMcpStatus,
  type McpHealthSupervisorDeps,
  type ProbeFn,
} from "../mcp/health-supervisor.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "srv-1",
    name: overrides.name ?? "Test Server",
    slug: overrides.slug ?? "test-server",
    transport: overrides.transport ?? "streamable-http",
    connection: overrides.connection ?? { url: "https://example.com/mcp" },
    agent_scope: overrides.agent_scope ?? [],
    description: overrides.description ?? null,
    status: overrides.status ?? "PENDING",
    protocol_version: overrides.protocol_version ?? null,
    server_info: overrides.server_info ?? null,
    capabilities: overrides.capabilities ?? null,
    health_probe_interval_ms: overrides.health_probe_interval_ms ?? 30000,
    last_healthy_at: overrides.last_healthy_at ?? null,
    error_message: overrides.error_message ?? null,
    created_at: overrides.created_at ?? new Date("2025-01-01"),
    updated_at: overrides.updated_at ?? new Date("2025-01-01"),
  }
}

function mockDb(servers: ReturnType<typeof makeServer>[]) {
  const execute = vi.fn().mockResolvedValue(servers)

  const where = vi.fn()
  where.mockReturnValue({ where, execute })

  const selectAll = vi.fn().mockReturnValue({ where, execute })
  const selectFrom = vi.fn().mockReturnValue({ selectAll, where, execute })

  // Update chain
  const updateExecute = vi.fn().mockResolvedValue(undefined)
  const updateWhere = vi.fn().mockReturnValue({ execute: updateExecute })
  const set = vi.fn().mockReturnValue({ where: updateWhere })
  const updateTable = vi.fn().mockReturnValue({ set })

  return {
    selectFrom,
    updateTable,
    _execute: execute,
    _updateExecute: updateExecute,
    _set: set,
  } as unknown as McpHealthSupervisorDeps["db"] & {
    _execute: ReturnType<typeof vi.fn>
    _updateExecute: ReturnType<typeof vi.fn>
    _set: ReturnType<typeof vi.fn>
  }
}

function mockSseManager() {
  return {
    broadcast: vi.fn(),
  } as unknown as McpHealthSupervisorDeps["sseManager"] & {
    broadcast: ReturnType<typeof vi.fn>
  }
}

function buildSupervisor(opts: {
  servers?: ReturnType<typeof makeServer>[]
  probeFn?: ProbeFn
  sseManager?: ReturnType<typeof mockSseManager>
  defaultProbeIntervalMs?: number
  cbConfig?: Record<string, number>
}) {
  const db = mockDb(opts.servers ?? [])
  const sse = opts.sseManager ?? mockSseManager()
  const probeFn = opts.probeFn ?? vi.fn().mockResolvedValue(undefined)

  const supervisor = new McpHealthSupervisor({
    db,
    sseManager: sse,
    probeFn,
    defaultProbeIntervalMs: opts.defaultProbeIntervalMs ?? 1000,
    circuitBreakerConfig: opts.cbConfig,
  })

  return { supervisor, db, sse, probeFn: probeFn as ReturnType<typeof vi.fn> }
}

// ---------------------------------------------------------------------------
// Clock setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════
// circuitStateToMcpStatus
// ═══════════════════════════════════════════════════════════════════════════

describe("circuitStateToMcpStatus", () => {
  it("maps CLOSED to ACTIVE", () => {
    expect(circuitStateToMcpStatus("CLOSED")).toBe("ACTIVE")
  })

  it("maps HALF_OPEN to DEGRADED", () => {
    expect(circuitStateToMcpStatus("HALF_OPEN")).toBe("DEGRADED")
  })

  it("maps OPEN to ERROR", () => {
    expect(circuitStateToMcpStatus("OPEN")).toBe("ERROR")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Probe cycle basics
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — probe cycle", () => {
  it("probes servers on tick and records success", async () => {
    const server = makeServer()
    const { supervisor, probeFn } = buildSupervisor({ servers: [server] })

    supervisor.start()
    // tick fires immediately on start; let microtasks settle
    await vi.advanceTimersByTimeAsync(0)

    expect(probeFn).toHaveBeenCalledTimes(1)
    expect(probeFn).toHaveBeenCalledWith(server)

    const state = supervisor.getServerState("srv-1")
    expect(state).toBeDefined()
    expect(state!.status).toBe("ACTIVE")
    expect(state!.consecutiveFailures).toBe(0)
    expect(state!.lastError).toBeNull()

    supervisor.stop()
  })

  it("records failure and increments consecutiveFailures", async () => {
    const server = makeServer()
    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn: vi.fn().mockRejectedValue(new Error("connection refused")),
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    const state = supervisor.getServerState("srv-1")
    expect(state!.consecutiveFailures).toBe(1)
    expect(state!.lastError).toBe("connection refused")

    supervisor.stop()
  })

  it("does not probe DISABLED servers (filtered by DB query)", async () => {
    // Disabled servers are excluded by the query WHERE status != 'DISABLED'
    // so we verify that if DB returns no servers, no probes happen
    const { supervisor, probeFn } = buildSupervisor({ servers: [] })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(probeFn).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it("respects per-server probe interval", async () => {
    const server = makeServer({ health_probe_interval_ms: 5000 })
    const { supervisor, probeFn } = buildSupervisor({
      servers: [server],
      defaultProbeIntervalMs: 1000,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0) // first tick fires immediately
    expect(probeFn).toHaveBeenCalledTimes(1)

    // 1 second later — another tick fires, but server interval is 5s so no probe
    await vi.advanceTimersByTimeAsync(1000)
    expect(probeFn).toHaveBeenCalledTimes(1)

    // Advance to 5s total — now should probe again
    await vi.advanceTimersByTimeAsync(4000)
    expect(probeFn).toHaveBeenCalledTimes(2)

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Thresholds & circuit breaker transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — circuit breaker transitions", () => {
  it("trips circuit to OPEN after failureThreshold failures", async () => {
    const server = makeServer({ health_probe_interval_ms: 100 })
    const failCount = { n: 0 }
    const probeFn = vi.fn().mockImplementation(() => {
      failCount.n++
      return Promise.reject(new Error(`fail-${failCount.n}`))
    })

    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: {
        failureThreshold: 3,
        windowMs: 60_000,
        openDurationMs: 5_000,
        halfOpenMaxAttempts: 1,
        successThresholdToClose: 1,
      },
    })

    supervisor.start()

    // Tick 1 — failure 1
    await vi.advanceTimersByTimeAsync(0)
    expect(supervisor.getServerState("srv-1")!.status).not.toBe("ERROR")

    // Tick 2 — failure 2
    await vi.advanceTimersByTimeAsync(100)
    expect(supervisor.getServerState("srv-1")!.status).not.toBe("ERROR")

    // Tick 3 — failure 3, should trip
    await vi.advanceTimersByTimeAsync(100)
    expect(supervisor.getServerState("srv-1")!.status).toBe("ERROR")

    supervisor.stop()
  })

  it("skips probe when circuit is OPEN", async () => {
    const server = makeServer({ health_probe_interval_ms: 100 })
    let callCount = 0
    const probeFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.reject(new Error("fail"))
    })

    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: {
        failureThreshold: 1,
        windowMs: 60_000,
        openDurationMs: 10_000,
        halfOpenMaxAttempts: 1,
        successThresholdToClose: 1,
      },
    })

    supervisor.start()
    // Tick 1 — trips to OPEN after 1 failure
    await vi.advanceTimersByTimeAsync(0)
    expect(callCount).toBe(1)

    // Tick 2,3,4 — should be skipped (OPEN)
    await vi.advanceTimersByTimeAsync(300)
    expect(callCount).toBe(1) // no additional probes

    supervisor.stop()
  })

  it("recovers from HALF_OPEN to ACTIVE after success", async () => {
    const server = makeServer({ health_probe_interval_ms: 100 })
    let shouldFail = true
    const probeFn = vi.fn().mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error("fail"))
      return Promise.resolve()
    })

    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: {
        failureThreshold: 1,
        windowMs: 60_000,
        openDurationMs: 500,
        halfOpenMaxAttempts: 1,
        successThresholdToClose: 1,
      },
    })

    supervisor.start()
    // Tick 1 — trip to OPEN
    await vi.advanceTimersByTimeAsync(0)
    expect(supervisor.getServerState("srv-1")!.status).toBe("ERROR")

    // Wait for openDurationMs to transition to HALF_OPEN
    shouldFail = false
    await vi.advanceTimersByTimeAsync(600)

    // The circuit breaker auto-transitions OPEN→HALF_OPEN on getState()
    // Next tick should probe and succeed
    const state = supervisor.getServerState("srv-1")!
    expect(state.status).toBe("ACTIVE")

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DB updates
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — DB updates", () => {
  it("updates DB with ACTIVE status and last_healthy_at on success", async () => {
    const server = makeServer()
    const { supervisor, db } = buildSupervisor({ servers: [server] })
    const mockDb = db as unknown as { updateTable: ReturnType<typeof vi.fn> }

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockDb.updateTable).toHaveBeenCalled()
    supervisor.stop()
  })

  it("updates DB with error_message on failure", async () => {
    const server = makeServer()
    const { supervisor, db } = buildSupervisor({
      servers: [server],
      probeFn: vi.fn().mockRejectedValue(new Error("timeout")),
    })
    const mockDb = db as unknown as {
      updateTable: ReturnType<typeof vi.fn>
      _set: ReturnType<typeof vi.fn>
    }

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockDb.updateTable).toHaveBeenCalled()

    // Verify the set() call contains error_message
    const setCall = mockDb._set.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(setCall).toBeDefined()
    expect(setCall!.error_message).toBe("timeout")

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// SSE broadcasts
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — SSE broadcasts", () => {
  it("broadcasts on status change", async () => {
    const server = makeServer({ status: "PENDING" })
    const sse = mockSseManager()
    const { supervisor } = buildSupervisor({
      servers: [server],
      sseManager: sse,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    // PENDING → ACTIVE should trigger a broadcast
    expect(sse.broadcast).toHaveBeenCalledTimes(1)
    const args = sse.broadcast.mock.calls[0]
    expect(args[0]).toBe("_mcp_health")
    const data = args[2] as Record<string, unknown>
    expect(data.previousStatus).toBe("PENDING")
    expect(data.status).toBe("ACTIVE")

    supervisor.stop()
  })

  it("does not broadcast when status unchanged", async () => {
    const server = makeServer({ status: "ACTIVE" })
    const sse = mockSseManager()

    // Force initial state to be ACTIVE already by using a server that starts ACTIVE
    const { supervisor } = buildSupervisor({
      servers: [server],
      sseManager: sse,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    // First tick: reconcile sets status to ACTIVE (from DB), probe succeeds → ACTIVE
    // Since reconcile sets initial state from server.status, and probe produces ACTIVE,
    // no change → no broadcast... BUT the first time the server is probed,
    // state is initialized from server.status, so ACTIVE→ACTIVE = no change
    // However the circuit starts CLOSED→ACTIVE, and if initial status was ACTIVE, no broadcast
    // The initial status is set from server.status in reconcile, so ACTIVE→ACTIVE: no broadcast
    // (depends on implementation detail)

    // Second tick should definitely not broadcast
    await vi.advanceTimersByTimeAsync(1000)
    // After first tick broadcast count + second tick: should still be same
    const firstBroadcastCount = sse.broadcast.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(sse.broadcast.mock.calls.length).toBe(firstBroadcastCount)

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Health report
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — getHealthReport", () => {
  it("returns ok when all servers are ACTIVE", async () => {
    const server = makeServer()
    const { supervisor } = buildSupervisor({ servers: [server] })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    const report = supervisor.getHealthReport()
    expect(report.status).toBe("ok")
    expect(report.servers).toHaveLength(1)
    expect(report.servers[0].status).toBe("ACTIVE")
    expect(report.servers[0].slug).toBe("test-server")

    supervisor.stop()
  })

  it("returns degraded when some servers are unhealthy", async () => {
    const server1 = makeServer({ id: "srv-1", slug: "server-1" })
    const server2 = makeServer({ id: "srv-2", slug: "server-2" })
    let callNum = 0
    const probeFn = vi.fn().mockImplementation(() => {
      callNum++
      // Fail only server-2 probes
      if (callNum % 2 === 0) return Promise.reject(new Error("down"))
      return Promise.resolve()
    })

    const { supervisor } = buildSupervisor({
      servers: [server1, server2],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: { failureThreshold: 1, openDurationMs: 60_000 },
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    const report = supervisor.getHealthReport()
    // server-1 ACTIVE, server-2 ERROR → degraded
    const statuses = report.servers.map((s) => s.status)
    expect(statuses).toContain("ACTIVE")
    expect(statuses).toContain("ERROR")
    expect(report.status).toBe("degraded")

    supervisor.stop()
  })

  it("returns unavailable when all servers are ERROR", async () => {
    const server = makeServer()
    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn: vi.fn().mockRejectedValue(new Error("fail")),
      cbConfig: { failureThreshold: 1, openDurationMs: 60_000 },
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    const report = supervisor.getHealthReport()
    expect(report.status).toBe("unavailable")

    supervisor.stop()
  })

  it("returns ok with empty server list", () => {
    const { supervisor } = buildSupervisor({ servers: [] })
    const report = supervisor.getHealthReport()
    expect(report.status).toBe("ok")
    expect(report.servers).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle (start/stop)
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — lifecycle", () => {
  it("does not probe after stop", async () => {
    const server = makeServer()
    const probeFn = vi.fn().mockResolvedValue(undefined)
    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0) // first tick
    expect(probeFn).toHaveBeenCalledTimes(1)

    supervisor.stop()

    // Advance time — no more probes
    await vi.advanceTimersByTimeAsync(500)
    expect(probeFn).toHaveBeenCalledTimes(1)
  })

  it("start is idempotent", async () => {
    const server = makeServer()
    const probeFn = vi.fn().mockResolvedValue(undefined)
    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
    })

    supervisor.start()
    supervisor.start() // second call should be a no-op
    await vi.advanceTimersByTimeAsync(0)

    // Only one timer should be running → one probe
    expect(probeFn).toHaveBeenCalledTimes(1)

    supervisor.stop()
  })

  it("can be restarted after stop", async () => {
    const server = makeServer({ health_probe_interval_ms: 100 })
    const probeFn = vi.fn().mockResolvedValue(undefined)
    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(probeFn).toHaveBeenCalledTimes(1)

    supervisor.stop()

    // Advance past the per-server interval so it re-probes on restart
    await vi.advanceTimersByTimeAsync(200)

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(probeFn).toHaveBeenCalledTimes(2)

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Server reconciliation
// ═══════════════════════════════════════════════════════════════════════════

describe("McpHealthSupervisor — reconciliation", () => {
  it("adds new servers discovered in DB", async () => {
    const server = makeServer()
    const { supervisor } = buildSupervisor({ servers: [server] })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(supervisor.getServerState("srv-1")).toBeDefined()
    supervisor.stop()
  })

  it("removes servers deleted from DB", async () => {
    const server = makeServer()
    const db = mockDb([server])
    const probeFn = vi.fn().mockResolvedValue(undefined)

    const supervisor = new McpHealthSupervisor({
      db,
      probeFn,
      defaultProbeIntervalMs: 100,
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(supervisor.getServerState("srv-1")).toBeDefined()

    // Now change DB to return empty list
    ;(db as unknown as { _execute: ReturnType<typeof vi.fn> })._execute.mockResolvedValue([])

    await vi.advanceTimersByTimeAsync(100)
    expect(supervisor.getServerState("srv-1")).toBeUndefined()

    supervisor.stop()
  })
})
