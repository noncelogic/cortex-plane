/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import Fastify from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ModelDiscoveryService } from "../auth/model-discovery.js"
import { modelRoutes } from "../routes/models.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDiscovery(svc: ModelDiscoveryService): void {
  const providers: Record<string, { id: string; label: string; providers: string[] }[]> = {
    anthropic: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["anthropic"] },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providers: ["anthropic"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providers: ["anthropic"] },
    ],
    openai: [
      { id: "gpt-4o", label: "GPT-4o", providers: ["openai"] },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai"] },
    ],
    "google-ai-studio": [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", providers: ["google-ai-studio"] },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", providers: ["google-ai-studio"] },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", providers: ["google-ai-studio"] },
    ],
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (svc as any).cache as Map<string, unknown>
  for (const [providerId, models] of Object.entries(providers)) {
    cache.set(providerId, { models, expiresAt: Date.now() + 60 * 60 * 1000 })
  }
}

let discovery: ModelDiscoveryService

beforeEach(() => {
  discovery = new ModelDiscoveryService()
  seedDiscovery(discovery)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function buildTestApp(deps?: Parameters<typeof modelRoutes>[0]) {
  const app = Fastify({ logger: false })
  await app.register(modelRoutes({ ...deps, discoveryService: discovery }))
  return app
}

// ---------------------------------------------------------------------------
// Tests: GET /models
// ---------------------------------------------------------------------------

describe("GET /models", () => {
  it("returns discovered models", async () => {
    const app = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/models" })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models).toBeDefined()
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.providerModels.length).toBeGreaterThan(0)
    expect(body.providers.length).toBeGreaterThan(0)
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

  it("returns canonical catalogue when cache is empty", async () => {
    const emptyDiscovery = new ModelDiscoveryService()
    const app = Fastify({ logger: false })
    await app.register(modelRoutes({ discoveryService: emptyDiscovery }))

    const res = await app.inject({ method: "GET", url: "/models" })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models.length).toBeGreaterThan(0)
  })

  it("returns canonical catalogue when credentialAware=true but no deps provided", async () => {
    const emptyDiscovery = new ModelDiscoveryService()
    const app = Fastify({ logger: false })
    await app.register(modelRoutes({ discoveryService: emptyDiscovery }))

    const res = await app.inject({
      method: "GET",
      url: "/models?credentialAware=true",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models.length).toBeGreaterThan(0)
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
        discoveryService: discovery,
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
    expect(
      body.providerModels.every((m: { providerId: string }) => m.providerId === "anthropic"),
    ).toBe(true)
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
        discoveryService: discovery,
      }),
    )

    const res = await app.inject({
      method: "GET",
      url: "/models?credentialAware=true",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.models.length).toBeGreaterThan(0)
  })
})
