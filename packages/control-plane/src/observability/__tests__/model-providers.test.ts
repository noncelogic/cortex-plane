import { describe, expect, it } from "vitest"

import { ModelDiscoveryService } from "../../auth/model-discovery.js"
import { modelDiscoveryService, modelsForProvider, providersForModel } from "../model-providers.js"

// ---------------------------------------------------------------------------
// Seed the shared discovery service with models so lookup helpers work
// ---------------------------------------------------------------------------

function seedCache(svc: ModelDiscoveryService): void {
  // Directly populate cache by calling discoverModels-like internals.
  // We use the public API: populate via cache entries.
  const providers: Record<string, { id: string; label: string; providers: string[] }[]> = {
    anthropic: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["anthropic"] },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providers: ["anthropic"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providers: ["anthropic"] },
    ],
    "google-antigravity": [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["google-antigravity"] },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providers: ["google-antigravity"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providers: ["google-antigravity"] },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", providers: ["google-antigravity"] },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", providers: ["google-antigravity"] },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", providers: ["google-antigravity"] },
    ],
    openai: [
      { id: "gpt-4o", label: "GPT-4o", providers: ["openai"] },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai"] },
    ],
    "openai-codex": [
      { id: "gpt-4o", label: "GPT-4o", providers: ["openai-codex"] },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai-codex"] },
    ],
    "google-ai-studio": [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", providers: ["google-ai-studio"] },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", providers: ["google-ai-studio"] },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", providers: ["google-ai-studio"] },
    ],
  }

  // Use internal cache access for test seeding
  for (const [providerId, models] of Object.entries(providers)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    ;(svc as any).cache.set(providerId, {
      models,
      expiresAt: Date.now() + 60 * 60 * 1000,
    })
  }
}

// Seed the shared singleton for these tests
seedCache(modelDiscoveryService)

describe("model-providers (dynamic)", () => {
  describe("providersForModel", () => {
    it("returns anthropic + google-antigravity for claude models", () => {
      const p = providersForModel("claude-sonnet-4-6")
      expect(p).toContain("anthropic")
      expect(p).toContain("google-antigravity")
    })

    it("returns openai + openai-codex for gpt models", () => {
      const p = providersForModel("gpt-4o")
      expect(p).toContain("openai")
      expect(p).toContain("openai-codex")
    })

    it("returns google-antigravity + google-ai-studio for gemini models", () => {
      const p = providersForModel("gemini-2.5-pro")
      expect(p).toContain("google-antigravity")
      expect(p).toContain("google-ai-studio")
    })

    it("returns undefined for unknown models", () => {
      expect(providersForModel("unknown-model")).toBeUndefined()
    })
  })

  describe("modelsForProvider", () => {
    it("returns claude models for anthropic provider", () => {
      const models = modelsForProvider("anthropic")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("claude-sonnet-4-6")
      expect(ids).toContain("claude-opus-4-6")
      expect(ids).toContain("claude-haiku-4-5")
      expect(ids).not.toContain("gpt-4o")
    })

    it("returns claude + gemini models for google-antigravity provider", () => {
      const models = modelsForProvider("google-antigravity")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("claude-sonnet-4-6")
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).not.toContain("gpt-4o")
    })

    it("returns gemini models for google-ai-studio provider", () => {
      const models = modelsForProvider("google-ai-studio")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).toContain("gemini-2.5-flash")
      expect(ids).toContain("gemini-2.0-flash")
      expect(ids).not.toContain("claude-sonnet-4-6")
    })

    it("returns gpt models for openai provider", () => {
      const models = modelsForProvider("openai")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("gpt-4o")
      expect(ids).toContain("gpt-4o-mini")
      expect(ids).not.toContain("claude-sonnet-4-6")
    })

    it("returns empty array for providers with no models", () => {
      expect(modelsForProvider("brave")).toEqual([])
      expect(modelsForProvider("unknown")).toEqual([])
    })
  })

  describe("getAllCachedModels", () => {
    it("every entry has id, label, and non-empty providers", () => {
      const all = modelDiscoveryService.getAllCachedModels()
      for (const m of all) {
        expect(m.id).toBeTruthy()
        expect(m.label).toBeTruthy()
        expect(m.providers.length).toBeGreaterThan(0)
      }
    })

    it("includes gemini models", () => {
      const ids = modelDiscoveryService.getAllCachedModels().map((m) => m.id)
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).toContain("gemini-2.5-flash")
      expect(ids).toContain("gemini-2.0-flash")
    })
  })
})
