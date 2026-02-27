import { describe, expect, it, vi } from "vitest"

import type { CircuitBreakerConfig } from "../backends/circuit-breaker.js"
import {
  ProviderRouter,
  type ProviderEntry,
  type RoutingEvent,
} from "../backends/provider-router.js"
import type {
  BackendCapabilities,
  BackendHealthReport,
  ExecutionBackend,
  ExecutionTask,
} from "../backends/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function createMockBackend(id: string): ExecutionBackend {
  return {
    backendId: id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({
      backendId: id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: 50,
      details: {},
    } satisfies BackendHealthReport),
    executeTask: vi.fn().mockRejectedValue(new Error("Not implemented in mock")),
    getCapabilities: vi.fn().mockReturnValue({
      supportsStreaming: true,
      supportsFileEdit: true,
      supportsShellExecution: true,
      reportsTokenUsage: true,
      supportsCancellation: true,
      supportedGoalTypes: ["code_edit"],
      maxContextTokens: 200_000,
    } satisfies BackendCapabilities),
  }
}

function makeTask(): ExecutionTask {
  return {
    id: "task-001",
    jobId: "job-001",
    agentId: "agent-001",
    instruction: {
      prompt: "Do something",
      goalType: "code_edit",
    },
    context: {
      workspacePath: "/workspace",
      systemPrompt: "",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 60_000,
      maxTokens: 200_000,
      model: "claude-sonnet-4-5-20250929",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 10,
      networkAccess: false,
      shellAccess: true,
    },
  }
}

function createRouter(now?: () => number): ProviderRouter {
  return new ProviderRouter(now)
}

function addProvider(
  router: ProviderRouter,
  id: string,
  priority: number,
  config?: Partial<CircuitBreakerConfig>,
): ExecutionBackend {
  const backend = createMockBackend(id)
  router.addProvider({ providerId: id, backend, priority, circuitBreakerConfig: config })
  return backend
}

// ──────────────────────────────────────────────────
// Primary Selection
// ──────────────────────────────────────────────────

describe("ProviderRouter — primary selection", () => {
  it("routes to highest priority provider (lowest number)", () => {
    const router = createRouter()
    const backendA = addProvider(router, "provider-a", 1)
    addProvider(router, "provider-b", 2)

    const result = router.route(makeTask())
    expect(result.providerId).toBe("provider-a")
    expect(result.backend).toBe(backendA)
  })

  it("routes to sole provider", () => {
    const router = createRouter()
    const backend = addProvider(router, "only-one", 0)

    const result = router.route(makeTask())
    expect(result.providerId).toBe("only-one")
    expect(result.backend).toBe(backend)
  })

  it("sorts providers by priority regardless of add order", () => {
    const router = createRouter()
    addProvider(router, "low-priority", 10)
    const highPrio = addProvider(router, "high-priority", 1)
    addProvider(router, "mid-priority", 5)

    const result = router.route(makeTask())
    expect(result.providerId).toBe("high-priority")
    expect(result.backend).toBe(highPrio)
  })
})

// ──────────────────────────────────────────────────
// Failover on circuit-open
// ──────────────────────────────────────────────────

describe("ProviderRouter — failover on circuit-open", () => {
  it("skips provider with OPEN circuit and routes to next", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "primary", 1, { failureThreshold: 1, openDurationMs: 30_000 })
    const fallback = addProvider(router, "fallback", 2)

    // Trip primary
    router.recordOutcome("primary", false, "transient")

    const result = router.route(makeTask())
    expect(result.providerId).toBe("fallback")
    expect(result.backend).toBe(fallback)
  })

  it("emits route_skipped event when skipping OPEN circuit", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "primary", 1, { failureThreshold: 1, openDurationMs: 30_000 })
    addProvider(router, "fallback", 2)

    router.recordOutcome("primary", false, "transient")

    const events: RoutingEvent[] = []
    router.onRoutingEvent((e) => events.push(e))

    router.route(makeTask())

    const skipped = events.find((e) => e.type === "route_skipped")
    expect(skipped).toBeDefined()
    expect(skipped!.providerId).toBe("primary")
    expect(skipped!.reason).toBe("circuit_open")
  })

  it("returns to primary after circuit recovers", () => {
    let time = 0
    const router = createRouter(() => time)
    const primary = addProvider(router, "primary", 1, {
      failureThreshold: 1,
      openDurationMs: 1000,
      successThresholdToClose: 1,
    })
    addProvider(router, "fallback", 2)

    // Trip primary
    router.recordOutcome("primary", false, "transient")

    // Wait for half-open
    time = 1000
    const halfOpenResult = router.route(makeTask())
    expect(halfOpenResult.providerId).toBe("primary")

    // Record success → close
    router.recordOutcome("primary", true)

    const closedResult = router.route(makeTask())
    expect(closedResult.providerId).toBe("primary")
    expect(closedResult.backend).toBe(primary)
  })
})

// ──────────────────────────────────────────────────
// All circuits open
// ──────────────────────────────────────────────────

describe("ProviderRouter — all circuits open", () => {
  it("throws when all circuits are open", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "a", 1, { failureThreshold: 1, openDurationMs: 30_000 })
    addProvider(router, "b", 2, { failureThreshold: 1, openDurationMs: 30_000 })

    router.recordOutcome("a", false, "transient")
    router.recordOutcome("b", false, "transient")

    expect(() => router.route(makeTask())).toThrow("All provider circuits are open")
  })

  it("emits route_exhausted event when all circuits open", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "a", 1, { failureThreshold: 1, openDurationMs: 30_000 })

    router.recordOutcome("a", false, "transient")

    const events: RoutingEvent[] = []
    router.onRoutingEvent((e) => events.push(e))

    try {
      router.route(makeTask())
    } catch {
      // expected
    }

    const exhausted = events.find((e) => e.type === "route_exhausted")
    expect(exhausted).toBeDefined()
    expect(exhausted!.reason).toBe("all_circuits_open")
  })
})

// ──────────────────────────────────────────────────
// Half-open behavior
// ──────────────────────────────────────────────────

describe("ProviderRouter — half-open behavior", () => {
  it("skips half-open provider at capacity", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "primary", 1, {
      failureThreshold: 1,
      openDurationMs: 1000,
      halfOpenMaxAttempts: 1,
    })
    const fallback = addProvider(router, "fallback", 2)

    // Trip primary
    router.recordOutcome("primary", false, "transient")

    // Go half-open
    time = 1000

    // First request takes the half-open slot
    const first = router.route(makeTask())
    expect(first.providerId).toBe("primary")

    // Second request should failover — slot is occupied
    const second = router.route(makeTask())
    expect(second.providerId).toBe("fallback")
    expect(second.backend).toBe(fallback)
  })
})

// ──────────────────────────────────────────────────
// routeWithFailover
// ──────────────────────────────────────────────────

describe("ProviderRouter — routeWithFailover", () => {
  it("selects primary when healthy", () => {
    const router = createRouter()
    const primary = addProvider(router, "primary", 1)
    addProvider(router, "secondary", 2)

    const result = router.routeWithFailover(makeTask())
    expect(result.providerId).toBe("primary")
    expect(result.backend).toBe(primary)
  })

  it("emits failover event when falling back", () => {
    let time = 0
    const router = createRouter(() => time)
    addProvider(router, "primary", 1, { failureThreshold: 1, openDurationMs: 30_000 })
    addProvider(router, "secondary", 2)

    router.recordOutcome("primary", false, "transient")

    const events: RoutingEvent[] = []
    router.onRoutingEvent((e) => events.push(e))

    router.routeWithFailover(makeTask())

    const failover = events.find((e) => e.type === "route_failover")
    expect(failover).toBeDefined()
    expect(failover!.providerId).toBe("secondary")
    expect(failover!.reason).toContain("primary")
  })
})

// ──────────────────────────────────────────────────
// recordOutcome
// ──────────────────────────────────────────────────

describe("ProviderRouter — recordOutcome", () => {
  it("records success on circuit breaker", () => {
    const router = createRouter()
    addProvider(router, "provider", 1)

    router.recordOutcome("provider", true)

    const states = router.getCircuitStates()
    expect(states.get("provider")).toBe("CLOSED")
  })

  it("records failure on circuit breaker", () => {
    const router = createRouter()
    addProvider(router, "provider", 1, { failureThreshold: 1 })

    router.recordOutcome("provider", false, "transient")

    const states = router.getCircuitStates()
    expect(states.get("provider")).toBe("OPEN")
  })

  it("ignores outcome for unknown provider", () => {
    const router = createRouter()
    // Should not throw
    router.recordOutcome("unknown", true)
    router.recordOutcome("unknown", false, "transient")
  })
})

// ──────────────────────────────────────────────────
// getCircuitStates
// ──────────────────────────────────────────────────

describe("ProviderRouter — getCircuitStates", () => {
  it("returns state for all providers", () => {
    const router = createRouter()
    addProvider(router, "a", 1, { failureThreshold: 1 })
    addProvider(router, "b", 2)

    router.recordOutcome("a", false, "transient")

    const states = router.getCircuitStates()
    expect(states.size).toBe(2)
    expect(states.get("a")).toBe("OPEN")
    expect(states.get("b")).toBe("CLOSED")
  })
})

// ──────────────────────────────────────────────────
// getCircuitBreaker
// ──────────────────────────────────────────────────

describe("ProviderRouter — getCircuitBreaker", () => {
  it("returns the breaker for a known provider", () => {
    const router = createRouter()
    addProvider(router, "a", 1)

    const breaker = router.getCircuitBreaker("a")
    expect(breaker).toBeDefined()
    expect(breaker!.getState()).toBe("CLOSED")
  })

  it("returns undefined for unknown provider", () => {
    const router = createRouter()
    expect(router.getCircuitBreaker("unknown")).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────
// getProviderIds
// ──────────────────────────────────────────────────

describe("ProviderRouter — getProviderIds", () => {
  it("returns all provider IDs in priority order", () => {
    const router = createRouter()
    addProvider(router, "c", 3)
    addProvider(router, "a", 1)
    addProvider(router, "b", 2)

    expect(router.getProviderIds()).toEqual(["a", "b", "c"])
  })
})

// ──────────────────────────────────────────────────
// Event listeners
// ──────────────────────────────────────────────────

describe("ProviderRouter — event listeners", () => {
  it("emits route_selected on successful routing", () => {
    const router = createRouter()
    addProvider(router, "provider", 1)

    const events: RoutingEvent[] = []
    router.onRoutingEvent((e) => events.push(e))

    router.route(makeTask())

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe("route_selected")
    expect(events[0]!.providerId).toBe("provider")
  })

  it("supports multiple listeners", () => {
    const router = createRouter()
    addProvider(router, "provider", 1)

    const events1: RoutingEvent[] = []
    const events2: RoutingEvent[] = []
    router.onRoutingEvent((e) => events1.push(e))
    router.onRoutingEvent((e) => events2.push(e))

    router.route(makeTask())

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
  })
})

// ──────────────────────────────────────────────────
// No providers
// ──────────────────────────────────────────────────

describe("ProviderRouter — no providers", () => {
  it("throws when no providers are registered", () => {
    const router = createRouter()
    expect(() => router.route(makeTask())).toThrow("All provider circuits are open")
  })
})
