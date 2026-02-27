import { describe, expect, it, vi } from "vitest"

import { BackendRegistry } from "../backends/registry.js"
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
    executeTask: vi.fn().mockRejectedValue(new Error("Not implemented")),
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
    instruction: { prompt: "Do something", goalType: "code_edit" },
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
      model: "test-model",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 10,
      networkAccess: false,
      shellAccess: true,
    },
  }
}

// ──────────────────────────────────────────────────
// Circuit Breaker per Backend
// ──────────────────────────────────────────────────

describe("BackendRegistry — circuit breakers", () => {
  it("creates a circuit breaker for each registered backend", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))
    await registry.register(createMockBackend("b"))

    const breaker = registry.getCircuitBreaker("a")
    expect(breaker).toBeDefined()
    expect(breaker!.getState()).toBe("CLOSED")

    const breakerB = registry.getCircuitBreaker("b")
    expect(breakerB).toBeDefined()
  })

  it("returns undefined circuit breaker for unregistered backend", () => {
    const registry = new BackendRegistry()
    expect(registry.getCircuitBreaker("nonexistent")).toBeUndefined()
  })

  it("getCircuitStates returns state for all backends", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"), {}, 1, { failureThreshold: 1 })
    await registry.register(createMockBackend("b"))

    registry.recordOutcome("a", false, "transient")

    const states = registry.getCircuitStates()
    expect(states.size).toBe(2)
    expect(states.get("a")).toBe("OPEN")
    expect(states.get("b")).toBe("CLOSED")
  })

  it("getCircuitStats returns stats for all backends", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))

    registry.recordOutcome("a", true)

    const stats = registry.getCircuitStats()
    expect(stats.size).toBe(1)
    const statA = stats.get("a")!
    expect(statA.state).toBe("CLOSED")
    expect(statA.windowTotalCalls).toBeGreaterThanOrEqual(1)
  })

  it("accepts custom circuit breaker config per backend", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"), {}, 1, { failureThreshold: 2 })

    // First failure should not trip
    registry.recordOutcome("a", false, "transient")
    expect(registry.getCircuitBreaker("a")!.getState()).toBe("CLOSED")

    // Second failure should trip
    registry.recordOutcome("a", false, "transient")
    expect(registry.getCircuitBreaker("a")!.getState()).toBe("OPEN")
  })
})

// ──────────────────────────────────────────────────
// recordOutcome (direct, no router)
// ──────────────────────────────────────────────────

describe("BackendRegistry — recordOutcome (direct)", () => {
  it("records success on circuit breaker", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))

    registry.recordOutcome("a", true)
    expect(registry.getCircuitBreaker("a")!.getState()).toBe("CLOSED")
  })

  it("records failure on circuit breaker", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"), {}, 1, { failureThreshold: 1 })

    registry.recordOutcome("a", false, "transient")
    expect(registry.getCircuitBreaker("a")!.getState()).toBe("OPEN")
  })

  it("ignores outcome for unknown backend", () => {
    const registry = new BackendRegistry()
    // Should not throw
    registry.recordOutcome("nonexistent", true)
    registry.recordOutcome("nonexistent", false, "transient")
  })
})

// ──────────────────────────────────────────────────
// routeTask (without router)
// ──────────────────────────────────────────────────

describe("BackendRegistry — routeTask (no router)", () => {
  it("returns default backend when no preferred ID", async () => {
    const registry = new BackendRegistry()
    const backend = createMockBackend("default-backend")
    await registry.register(backend)

    const result = registry.routeTask(makeTask())
    expect(result.providerId).toBe("default-backend")
    expect(result.backend).toBe(backend)
  })

  it("returns preferred backend by ID", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))
    const backendB = createMockBackend("b")
    await registry.register(backendB)

    const result = registry.routeTask(makeTask(), "b")
    expect(result.providerId).toBe("b")
    expect(result.backend).toBe(backendB)
  })

  it("throws when no backend available", () => {
    const registry = new BackendRegistry()

    expect(() => registry.routeTask(makeTask())).toThrow("No execution backend available")
  })

  it("throws when preferred backend not found", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))

    expect(() => registry.routeTask(makeTask(), "nonexistent")).toThrow(
      "No execution backend available (requested: nonexistent)",
    )
  })
})

// ──────────────────────────────────────────────────
// configureRouter and routeTask (with router)
// ──────────────────────────────────────────────────

describe("BackendRegistry — configureRouter", () => {
  it("creates router with all registered backends", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))
    await registry.register(createMockBackend("b"))

    const router = registry.configureRouter()
    expect(router).toBeDefined()
    expect(router.getProviderIds()).toEqual(["a", "b"])
  })

  it("routeTask uses router when configured", async () => {
    const registry = new BackendRegistry()
    const backendA = createMockBackend("a")
    await registry.register(backendA)
    await registry.register(createMockBackend("b"))

    registry.configureRouter()

    const result = registry.routeTask(makeTask())
    expect(result.providerId).toBe("a")
    expect(result.backend).toBe(backendA)
  })

  it("router failover works through registry", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("primary"), {}, 1, { failureThreshold: 1 })
    const fallback = createMockBackend("fallback")
    await registry.register(fallback)

    const router = registry.configureRouter()

    // Trip primary circuit via router
    router.recordOutcome("primary", false, "transient")

    const result = registry.routeTask(makeTask())
    expect(result.providerId).toBe("fallback")
    expect(result.backend).toBe(fallback)
  })

  it("getRouter returns configured router", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))

    expect(registry.getRouter()).toBeUndefined()

    registry.configureRouter()
    expect(registry.getRouter()).toBeDefined()
  })

  it("recordOutcome goes through router when configured", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"), {}, 1, { failureThreshold: 1 })
    await registry.register(createMockBackend("b"))

    const router = registry.configureRouter()

    registry.recordOutcome("a", false, "transient")

    // Verify via router's circuit state
    const states = router.getCircuitStates()
    expect(states.get("a")).toBe("OPEN")
  })

  it("accepts external router", async () => {
    const registry = new BackendRegistry()
    const backendA = createMockBackend("a")
    await registry.register(backendA)

    const { ProviderRouter } = await import("../backends/provider-router.js")
    const externalRouter = new ProviderRouter()
    externalRouter.addProvider({ providerId: "a", backend: backendA, priority: 1 })

    registry.configureRouter(externalRouter)

    expect(registry.getRouter()).toBe(externalRouter)
    const result = registry.routeTask(makeTask())
    expect(result.providerId).toBe("a")
  })
})

// ──────────────────────────────────────────────────
// stopAll clears circuit breakers and router
// ──────────────────────────────────────────────────

describe("BackendRegistry — stopAll with circuit breakers", () => {
  it("clears circuit breakers on stopAll", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))

    expect(registry.getCircuitBreaker("a")).toBeDefined()

    await registry.stopAll()

    expect(registry.getCircuitBreaker("a")).toBeUndefined()
  })

  it("clears router on stopAll", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("a"))
    registry.configureRouter()

    expect(registry.getRouter()).toBeDefined()

    await registry.stopAll()

    expect(registry.getRouter()).toBeUndefined()
  })
})
