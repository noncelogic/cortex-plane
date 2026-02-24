import Fastify from "fastify"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { healthRoutes } from "../routes/health.js"

function buildTestApp(overrides?: { worker?: unknown; db?: unknown }) {
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
