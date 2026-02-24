import Fastify from "fastify"
import type { Runner } from "graphile-worker"
import { describe, expect, it } from "vitest"

import { healthRoutes } from "../routes/health.js"

describe("health routes", () => {
  it("GET /healthz returns ok", async () => {
    const app = Fastify()
    app.decorate("worker", {} as Runner)
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/healthz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok" })
  })

  it("GET /readyz returns ok when worker is present", async () => {
    const app = Fastify()
    app.decorate("worker", {} as Runner)
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok", worker: true })
  })

  it("GET /readyz returns 503 when worker is not set", async () => {
    const app = Fastify()
    app.decorate("worker", undefined as unknown as Runner)
    await app.register(healthRoutes)

    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: "not_ready", worker: false })
  })
})
