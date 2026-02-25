import Fastify from "fastify"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import {
  BackendRegistry,
  type BackendCapabilities,
  type BackendHealthReport,
  type ExecutionBackend,
} from "@cortex/shared/backends"
import type { Database } from "../db/types.js"
import { healthRoutes } from "../routes/health.js"

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

function buildTestApp(overrides?: {
  worker?: unknown
  db?: unknown
  backendRegistry?: BackendRegistry
}) {
  const app = Fastify()

  const mockDb =
    overrides && "db" in overrides
      ? overrides.db
      : {
          selectFrom: () => ({
            select: () => ({
              limit: () => ({
                execute: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }

  const worker = overrides && "worker" in overrides ? overrides.worker : {}

  app.decorate("worker", worker as Runner)
  app.decorate("db", mockDb as Kysely<Database>)
  if (overrides?.backendRegistry) {
    app.decorate("backendRegistry", overrides.backendRegistry)
  }
  return app
}

describe("health routes", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildTestApp()
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/healthz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok" })
  })

  it("GET /readyz returns ok when worker and db are available", async () => {
    const app = buildTestApp()
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: "ok",
      checks: { worker: true, db: true },
    })
  })

  it("GET /readyz returns 503 when worker is not set", async () => {
    const app = buildTestApp({ worker: undefined })
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { worker: false, db: true },
    })
  })

  it("GET /readyz returns 503 when db is unreachable", async () => {
    const failingDb = {
      selectFrom: () => ({
        select: () => ({
          limit: () => ({
            execute: vi.fn().mockRejectedValue(new Error("connection refused")),
          }),
        }),
      }),
    }
    const app = buildTestApp({ db: failingDb })
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { worker: true, db: false },
    })
  })
})

describe("health routes — /health/backends", () => {
  it("returns 503 when backendRegistry is not configured", async () => {
    const app = buildTestApp()
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/health/backends" })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: "unavailable",
      reason: "Backend registry not configured",
    })
  })

  it("returns backend health and circuit breaker state", async () => {
    const registry = new BackendRegistry()
    await registry.register(createMockBackend("claude-code"))
    await registry.register(createMockBackend("echo"))

    const app = buildTestApp({ backendRegistry: registry })
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/health/backends" })
    expect(response.statusCode).toBe(200)

    const body = response.json() as {
      status: string
      backends: Array<{
        backendId: string
        health: { status: string } | null
        circuitBreaker: { state: string } | null
      }>
    }
    expect(body.status).toBe("ok")
    expect(body.backends).toHaveLength(2)

    const ccBackend = body.backends.find((b) => b.backendId === "claude-code")
    expect(ccBackend).toBeDefined()
    expect(ccBackend!.health).toBeDefined()
    expect(ccBackend!.health!.status).toBe("healthy")
    expect(ccBackend!.circuitBreaker).toBeDefined()
    expect(ccBackend!.circuitBreaker!.state).toBe("CLOSED")

    const echoBackend = body.backends.find((b) => b.backendId === "echo")
    expect(echoBackend).toBeDefined()
    expect(echoBackend!.circuitBreaker!.state).toBe("CLOSED")
  })

  it("shows OPEN circuit when failures recorded", async () => {
    const registry = new BackendRegistry()
    await registry.register(
      createMockBackend("claude-code"),
      {},
      1,
      { failureThreshold: 1 },
    )

    // Trip the breaker
    registry.recordOutcome("claude-code", false, "transient")

    const app = buildTestApp({ backendRegistry: registry })
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/health/backends" })
    const body = response.json() as {
      backends: Array<{
        backendId: string
        circuitBreaker: { state: string; windowFailureCount: number } | null
      }>
    }

    const cc = body.backends.find((b) => b.backendId === "claude-code")
    expect(cc!.circuitBreaker!.state).toBe("OPEN")
    expect(cc!.circuitBreaker!.windowFailureCount).toBeGreaterThanOrEqual(1)
  })

  it("returns empty backends list when none registered", async () => {
    const registry = new BackendRegistry()

    const app = buildTestApp({ backendRegistry: registry })
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/health/backends" })
    const body = response.json() as { backends: unknown[] }
    expect(body.backends).toHaveLength(0)
  })
})
