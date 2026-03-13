/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

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

  it("includes Gemini models", async () => {
    const app = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/models" })
    const body = res.json()

    const ids = body.models.map((m: { id: string }) => m.id)
    expect(ids).toContain("gemini-2.5-pro")
    expect(ids).toContain("gemini-2.5-flash")
    expect(ids).toContain("gemini-2.0-flash")
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

  it("returns full catalogue when credentialAware=true but no deps provided", async () => {
    const app = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/models?credentialAware=true",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models).toEqual(MODEL_CATALOGUE)
  })

  it("filters models when credentialAware=true and user has credentials", async () => {
    const mockCredentialService = {
      listCredentials: vi
        .fn()
        .mockResolvedValue([{ provider: "anthropic", credentialClass: "llm_provider" }]),
    }
    const mockSessionService = {
      validateSession: vi.fn().mockResolvedValue({
        user: {
          userId: "user-1",
          role: "member",
          displayName: "Test",
          email: "test@example.com",
        },
      }),
    }

    const app = Fastify({ logger: false })
    await app.register(
      modelRoutes({
        credentialService: mockCredentialService as never,
        sessionService: mockSessionService as never,
      }),
    )

    const res = await app.inject({
      method: "GET",
      url: "/models?credentialAware=true",
      cookies: { cortex_session: "valid-session" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Only anthropic-compatible models should be returned
    for (const m of body.models) {
      expect(m.providers).toContain("anthropic")
    }
    // GPT models should NOT be included
    const ids = body.models.map((m: { id: string }) => m.id)
    expect(ids).not.toContain("gpt-4o")
    expect(ids).not.toContain("gpt-4o-mini")
  })

  it("returns full catalogue when credentialAware=true but auth fails", async () => {
    const mockCredentialService = {
      listCredentials: vi.fn(),
    }
    const mockSessionService = {
      validateSession: vi.fn().mockResolvedValue(null),
    }

    const app = Fastify({ logger: false })
    await app.register(
      modelRoutes({
        credentialService: mockCredentialService as never,
        sessionService: mockSessionService as never,
      }),
    )

    const res = await app.inject({
      method: "GET",
      url: "/models?credentialAware=true",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models).toEqual(MODEL_CATALOGUE)
  })
})
