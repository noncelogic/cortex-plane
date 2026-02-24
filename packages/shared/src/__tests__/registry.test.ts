import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BackendRegistry, BackendSemaphore, CachedHealthCheck } from "../backends/registry.js"
import type {
  BackendCapabilities,
  BackendHealthReport,
  ExecutionBackend,
} from "../backends/types.js"

// ──────────────────────────────────────────────────
// Mock Backend
// ──────────────────────────────────────────────────

function createMockBackend(id: string, healthy = true): ExecutionBackend {
  return {
    backendId: id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({
      backendId: id,
      status: healthy ? "healthy" : "unhealthy",
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

// ──────────────────────────────────────────────────
// BackendSemaphore
// ──────────────────────────────────────────────────

describe("BackendSemaphore", () => {
  it("acquires and releases permits within the limit", async () => {
    const semaphore = new BackendSemaphore(2)

    const permit1 = await semaphore.acquire(1000)
    expect(semaphore.available).toBe(1)
    expect(semaphore.currentActive).toBe(1)

    const permit2 = await semaphore.acquire(1000)
    expect(semaphore.available).toBe(0)
    expect(semaphore.currentActive).toBe(2)

    permit1.release()
    expect(semaphore.available).toBe(1)

    permit2.release()
    expect(semaphore.available).toBe(2)
  })

  it("queues requests when all permits are in use", async () => {
    const semaphore = new BackendSemaphore(1)

    const permit1 = await semaphore.acquire(1000)
    expect(semaphore.available).toBe(0)

    // This should queue and resolve when permit1 is released
    const acquirePromise = semaphore.acquire(5000)
    let acquired = false
    void acquirePromise.then(() => {
      acquired = true
    })

    // Give the event loop a tick
    await new Promise((r) => setTimeout(r, 10))
    expect(acquired).toBe(false)

    permit1.release()
    const permit2 = await acquirePromise
    expect(acquired).toBe(true)
    expect(semaphore.available).toBe(0)

    permit2.release()
    expect(semaphore.available).toBe(1)
  })

  it("rejects with timeout when no permit becomes available", async () => {
    const semaphore = new BackendSemaphore(1)

    const _permit = await semaphore.acquire(1000)

    await expect(semaphore.acquire(50)).rejects.toThrow("Backend semaphore timeout after 50ms")
  })
})

// ──────────────────────────────────────────────────
// CachedHealthCheck
// ──────────────────────────────────────────────────

describe("CachedHealthCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns cached result within TTL", async () => {
    const backend = createMockBackend("test")
    const cached = new CachedHealthCheck(backend, 30_000)

    const first = await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(1)

    const second = await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it("refreshes cache after TTL expires", async () => {
    const backend = createMockBackend("test")
    const cached = new CachedHealthCheck(backend, 30_000)

    await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(1)

    // Advance past TTL
    vi.advanceTimersByTime(31_000)

    await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(2)
  })

  it("forces refresh after invalidate()", async () => {
    const backend = createMockBackend("test")
    const cached = new CachedHealthCheck(backend, 30_000)

    await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(1)

    cached.invalidate()

    await cached.check()
    expect(backend.healthCheck).toHaveBeenCalledTimes(2)
  })
})

// ──────────────────────────────────────────────────
// BackendRegistry
// ──────────────────────────────────────────────────

describe("BackendRegistry", () => {
  it("registers a backend and calls start()", async () => {
    const registry = new BackendRegistry()
    const backend = createMockBackend("claude-code")

    await registry.register(backend, { binaryPath: "/usr/bin/claude" }, 1)

    expect(backend.start).toHaveBeenCalledWith({ binaryPath: "/usr/bin/claude" })
    expect(registry.get("claude-code")).toBe(backend)
  })

  it("throws when registering a duplicate backend ID", async () => {
    const registry = new BackendRegistry()
    const backend1 = createMockBackend("claude-code")
    const backend2 = createMockBackend("claude-code")

    await registry.register(backend1)
    await expect(registry.register(backend2)).rejects.toThrow("already registered")
  })

  it("returns undefined for unregistered backend", async () => {
    const registry = new BackendRegistry()
    expect(registry.get("nonexistent")).toBeUndefined()
  })

  it("sets first registered backend as default", async () => {
    const registry = new BackendRegistry()
    const backend1 = createMockBackend("claude-code")
    const backend2 = createMockBackend("codex")

    await registry.register(backend1)
    await registry.register(backend2)

    expect(registry.getDefault()).toBe(backend1)
  })

  it("returns undefined default when no backends are registered", () => {
    const registry = new BackendRegistry()
    expect(registry.getDefault()).toBeUndefined()
  })

  it("lists all registered backend IDs", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("claude-code"))
    await registry.register(createMockBackend("codex"))

    const ids = registry.list()
    expect(ids).toContain("claude-code")
    expect(ids).toContain("codex")
    expect(ids).toHaveLength(2)
  })

  it("returns health status for a registered backend", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("claude-code"))

    const health = await registry.getHealth("claude-code")
    expect(health).toBeDefined()
    expect(health!.status).toBe("healthy")
    expect(health!.backendId).toBe("claude-code")
  })

  it("returns undefined health for unregistered backend", async () => {
    const registry = new BackendRegistry()
    const health = await registry.getHealth("nonexistent")
    expect(health).toBeUndefined()
  })

  it("getAllHealth returns reports for all backends", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("claude-code"))
    await registry.register(createMockBackend("codex", false))

    const reports = await registry.getAllHealth()
    expect(reports).toHaveLength(2)

    const ccReport = reports.find((r) => r.backendId === "claude-code")
    expect(ccReport?.status).toBe("healthy")

    const codexReport = reports.find((r) => r.backendId === "codex")
    expect(codexReport?.status).toBe("unhealthy")
  })

  it("acquires and releases semaphore permits", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("claude-code"), {}, 2)

    const permit = await registry.acquirePermit("claude-code", 1000)
    expect(permit).toBeDefined()

    // Should not throw — release cleans up
    permit.release()
  })

  it("throws when acquiring permit for unregistered backend", async () => {
    const registry = new BackendRegistry()
    await expect(registry.acquirePermit("nonexistent", 1000)).rejects.toThrow(
      "No semaphore for backend",
    )
  })

  it("invalidates health cache for a backend", async () => {
    const registry = new BackendRegistry()
    const backend = createMockBackend("claude-code")
    await registry.register(backend)

    // First check — cached
    await registry.getHealth("claude-code")
    expect(backend.healthCheck).toHaveBeenCalledTimes(1)

    // Invalidate + re-check
    registry.invalidateHealth("claude-code")
    await registry.getHealth("claude-code")
    expect(backend.healthCheck).toHaveBeenCalledTimes(2)
  })

  it("stops all backends on stopAll()", async () => {
    const registry = new BackendRegistry()
    const backend1 = createMockBackend("claude-code")
    const backend2 = createMockBackend("codex")

    await registry.register(backend1)
    await registry.register(backend2)

    await registry.stopAll()

    expect(backend1.stop).toHaveBeenCalled()
    expect(backend2.stop).toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
    expect(registry.getDefault()).toBeUndefined()
  })

  it("stopAll clears all state even if a backend stop fails", async () => {
    const registry = new BackendRegistry()
    const failingBackend = createMockBackend("failing")
    ;(failingBackend.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Stop failed"))
    const goodBackend = createMockBackend("good")

    await registry.register(failingBackend)
    await registry.register(goodBackend)

    // Should not throw — uses Promise.allSettled
    await registry.stopAll()

    expect(registry.list()).toHaveLength(0)
  })
})
