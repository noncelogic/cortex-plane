/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import Fastify from "fastify"
import { describe, expect, it } from "vitest"

import { MODEL_CATALOGUE } from "../observability/model-providers.js"
import { modelRoutes } from "../routes/models.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(modelRoutes())
  return app
}

// ---------------------------------------------------------------------------
// Tests: GET /models
// ---------------------------------------------------------------------------

describe("GET /models", () => {
  it("returns the full model catalogue", async () => {
    const app = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/models",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models).toBeDefined()
    expect(body.models).toEqual(MODEL_CATALOGUE)
  })

  it("includes at least one Anthropic and one OpenAI model", async () => {
    const app = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/models" })
    const body = res.json()

    const hasAnthropic = body.models.some((m: { providers: string[] }) =>
      m.providers.includes("anthropic"),
    )
    const hasOpenAI = body.models.some((m: { providers: string[] }) =>
      m.providers.includes("openai"),
    )
    expect(hasAnthropic).toBe(true)
    expect(hasOpenAI).toBe(true)
  })

  it("every model has id, label, and providers array", async () => {
    const app = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/models" })
    const body = res.json()

    for (const m of body.models) {
      expect(typeof m.id).toBe("string")
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.label).toBe("string")
      expect(m.label.length).toBeGreaterThan(0)
      expect(Array.isArray(m.providers)).toBe(true)
      expect(m.providers.length).toBeGreaterThan(0)
    }
  })

  it("has unique model ids", async () => {
    const app = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/models" })
    const body = res.json()

    const ids = body.models.map((m: { id: string }) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
