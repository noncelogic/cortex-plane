import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ModelDiscoveryService } from "../model-discovery.js"

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("discoverModels — anthropic", () => {
  it("parses Anthropic models list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-6" }],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("anthropic", { apiKey: "sk-test" })

    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe("claude-sonnet-4-6")
    expect(models[0]!.providers).toEqual(["anthropic"])
    expect(models[1]!.id).toBe("claude-opus-4-6")

    // Verify correct headers
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain("/v1/models")
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test")
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses x-api-key auth when accessToken provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-haiku-4-5" }] }))

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("anthropic", { accessToken: "oauth-tok" })

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("oauth-tok")
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined()
  })

  it("falls back to static catalogue on API failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401))

    vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("anthropic", { apiKey: "bad" })

    // Static catalogue kicks in for anthropic
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "claude-sonnet-4-5")).toBe(true)
  })

  it("falls back to static catalogue on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"))

    vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("anthropic", { apiKey: "sk-test" })

    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "claude-sonnet-4-5")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("discoverModels — openai", () => {
  it("filters to chat models", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "gpt-4o" },
          { id: "gpt-4o-mini" },
          { id: "dall-e-3" },
          { id: "text-embedding-ada-002" },
          { id: "o1-preview" },
          { id: "o3-mini" },
          { id: "o4-mini" },
        ],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("openai", { apiKey: "sk-openai" })

    const ids = models.map((m) => m.id)
    expect(ids).toContain("gpt-4o")
    expect(ids).toContain("gpt-4o-mini")
    expect(ids).toContain("o1-preview")
    expect(ids).toContain("o3-mini")
    expect(ids).toContain("o4-mini")
    expect(ids).not.toContain("dall-e-3")
    expect(ids).not.toContain("text-embedding-ada-002")

    // All should have openai provider
    for (const m of models) {
      expect(m.providers).toEqual(["openai"])
    }
  })

  it("openai-codex tags models with openai-codex provider", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ slug: "gpt-5" }] }))

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("openai-codex", { accessToken: "tok" })

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/models")
    expect(models[0]!.id).toBe("gpt-5")
    expect(models[0]!.providers).toEqual(["openai-codex"])
  })

  it("falls back to static catalogue on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("openai", { apiKey: "sk-bad" })

    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "gpt-4o")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Google AI Studio
// ---------------------------------------------------------------------------

describe("discoverModels — google-ai-studio", () => {
  it("strips models/ prefix from names", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [{ name: "models/gemini-2.5-pro" }, { name: "models/gemini-2.5-flash" }],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("google-ai-studio", { apiKey: "AIza-test" })

    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe("gemini-2.5-pro")
    expect(models[0]!.providers).toEqual(["google-ai-studio"])
    expect(models[1]!.id).toBe("gemini-2.5-flash")

    // API key should be in the URL
    const [url] = fetchMock.mock.calls[0]! as [string]
    expect(url).toContain("key=AIza-test")
  })

  it("falls back to canonical catalogue without apiKey", async () => {
    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("google-ai-studio", { accessToken: "tok" })
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "gemini-2.5-pro")).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Google Antigravity
// ---------------------------------------------------------------------------

describe("discoverModels — google-antigravity", () => {
  it("calls the Antigravity proxy models endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "claude-sonnet-4-6" }, { id: "gemini-2.5-pro" }],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("google-antigravity", { accessToken: "goog-tok" })

    expect(models).toHaveLength(2)
    expect(models[0]!.providers).toEqual(["google-antigravity"])

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toContain("/v1/models")
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer goog-tok")
  })

  it("uses ANTIGRAVITY_BASE_URL env var", async () => {
    const original = process.env.ANTIGRAVITY_BASE_URL
    process.env.ANTIGRAVITY_BASE_URL = "https://custom-proxy.example.com"

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-opus-4-6" }] }))

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("google-antigravity", { accessToken: "tok" })

    const [url] = fetchMock.mock.calls[0]! as [string]
    expect(url).toBe("https://custom-proxy.example.com/v1/models")

    if (original === undefined) {
      delete process.env.ANTIGRAVITY_BASE_URL
    } else {
      process.env.ANTIGRAVITY_BASE_URL = original
    }
  })
})

// ---------------------------------------------------------------------------
// GitHub Copilot
// ---------------------------------------------------------------------------

describe("discoverModels — github-copilot", () => {
  it("parses GitHub Copilot models", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: "gpt-4o" }, { id: "claude-sonnet-4-6" }],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("github-copilot", { accessToken: "gh-tok" })

    expect(models).toHaveLength(2)
    expect(models[0]!.providers).toEqual(["github-copilot"])

    const [url] = fetchMock.mock.calls[0]! as [string]
    expect(url).toContain("githubcopilot.com/models")
  })

  it("handles array response format", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: "gpt-4o" }]))

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("github-copilot", { accessToken: "gh-tok" })

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe("gpt-4o")
  })
})

// ---------------------------------------------------------------------------
// Google Gemini CLI
// ---------------------------------------------------------------------------

describe("discoverModels — google-gemini-cli", () => {
  it("parses Gemini models with OAuth token", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        models: [{ name: "models/gemini-2.0-flash" }],
      }),
    )

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("google-gemini-cli", { accessToken: "oauth-tok" })

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe("gemini-2.0-flash")
    expect(models[0]!.providers).toEqual(["google-gemini-cli"])

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer oauth-tok")
  })
})

// ---------------------------------------------------------------------------
// Unknown provider
// ---------------------------------------------------------------------------

describe("discoverModels — unknown provider", () => {
  it("returns empty for unknown providers", async () => {
    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("some-unknown", { apiKey: "key" })
    expect(models).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe("cache", () => {
  it("caches results per provider", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-sonnet-4-6" }] }))

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("anthropic", { apiKey: "sk-test" })

    const cached = svc.getCachedModels("anthropic")
    expect(cached).toHaveLength(1)
    expect(cached[0]!.id).toBe("claude-sonnet-4-6")
  })

  it("returns empty for uncached providers", () => {
    const svc = new ModelDiscoveryService()
    expect(svc.getCachedModels("openai")).toEqual([])
  })

  it("invalidate clears cache for a provider", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-4o" }] }))

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("openai", { apiKey: "sk-openai" })

    expect(svc.getCachedModels("openai")).toHaveLength(1)

    svc.invalidate("openai")
    expect(svc.getCachedModels("openai")).toEqual([])
  })

  it("invalidateAll clears all caches", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-sonnet-4-6" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-4o" }] }))

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("anthropic", { apiKey: "sk-a" })
    await svc.discoverModels("openai", { apiKey: "sk-o" })

    expect(svc.getAllCachedModels()).toHaveLength(2)

    svc.invalidateAll()
    expect(svc.getAllCachedModels()).toEqual([])
  })

  it("caches canonical fallback results for providers with static catalogue", async () => {
    const svc = new ModelDiscoveryService()
    await svc.discoverModels("google-ai-studio", { accessToken: "tok" })

    expect(svc.getCachedModels("google-ai-studio").length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getAllCachedModels — deduplication
// ---------------------------------------------------------------------------

describe("getAllCachedModels", () => {
  it("merges providers for duplicate model IDs", async () => {
    // Same model ID from two providers
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-sonnet-4-6" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "claude-sonnet-4-6" }, { id: "gemini-2.5-pro" }] }),
      )

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("anthropic", { apiKey: "sk-a" })
    await svc.discoverModels("google-antigravity", { accessToken: "tok" })

    const all = svc.getAllCachedModels()
    const claude = all.find((m) => m.id === "claude-sonnet-4-6")
    expect(claude).toBeDefined()
    expect(claude!.providers).toContain("anthropic")
    expect(claude!.providers).toContain("google-antigravity")

    const gemini = all.find((m) => m.id === "gemini-2.5-pro")
    expect(gemini).toBeDefined()
    expect(gemini!.providers).toEqual(["google-antigravity"])
  })
})

// ---------------------------------------------------------------------------
// Static catalogue fallback
// ---------------------------------------------------------------------------

describe("discoverModels — static catalogue fallback", () => {
  it("falls back to static catalogue when google-antigravity API returns 404", async () => {
    // Both endpoints return 404
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("google-antigravity", { accessToken: "tok" })

    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "gemini-3-flash")).toBe(true)
    expect(models.every((m) => m.providers.includes("google-antigravity"))).toBe(true)

    // Warning should have been logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("static model catalogue"))

    warnSpy.mockRestore()
  })

  it("falls back to static catalogue when anthropic API fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("anthropic", { apiKey: "bad-key" })

    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "claude-sonnet-4-5")).toBe(true)
    expect(models.every((m) => m.providers.includes("anthropic"))).toBe(true)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("static model catalogue"))

    warnSpy.mockRestore()
  })

  it("falls back to static catalogue when openai-codex API fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("openai-codex", { apiKey: "bad" })

    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === "gpt-5.1")).toBe(true)

    warnSpy.mockRestore()
  })

  it("does NOT fall back when dynamic discovery succeeds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "claude-sonnet-4-6" }] }))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("anthropic", { apiKey: "sk-good" })

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe("claude-sonnet-4-6")

    // No fallback warning
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it("does NOT fall back for providers without static catalogue", async () => {
    const svc = new ModelDiscoveryService()
    const models = await svc.discoverModels("some-unknown", { apiKey: "key" })
    expect(models).toEqual([])
  })

  it("caches fallback results", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404))

    vi.spyOn(console, "warn").mockImplementation(() => {})

    const svc = new ModelDiscoveryService()
    await svc.discoverModels("google-antigravity", { accessToken: "tok" })

    const cached = svc.getCachedModels("google-antigravity")
    expect(cached.length).toBeGreaterThan(0)
    expect(cached.some((m) => m.id === "gemini-3-flash")).toBe(true)
  })
})
