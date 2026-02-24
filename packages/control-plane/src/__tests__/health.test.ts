import { describe, expect, it } from "vitest"

import { buildApp } from "../app.js"

describe("health routes", () => {
  it("GET /healthz returns ok", async () => {
    const app = await buildApp()
    const response = await app.inject({ method: "GET", url: "/healthz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok" })
  })

  it("GET /readyz returns ok", async () => {
    const app = await buildApp()
    const response = await app.inject({ method: "GET", url: "/readyz" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: "ok" })
  })
})
