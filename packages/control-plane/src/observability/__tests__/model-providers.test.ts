import { describe, expect, it } from "vitest"

import { listAllModels, modelsForProvider, providersForModel } from "../model-providers.js"

describe("model-providers (dynamic)", () => {
  describe("providersForModel", () => {
    it("returns anthropic + google-antigravity for supported claude models", () => {
      const p = providersForModel("claude-sonnet-4-5")
      expect(p).toContain("anthropic")
      expect(p).toContain("google-antigravity")
    })

    it("returns openai + github-copilot for gpt models", () => {
      const p = providersForModel("gpt-4o")
      expect(p).toContain("openai")
      expect(p).toContain("github-copilot")
    })

    it("returns google-ai-studio + google-gemini-cli for gemini models", () => {
      const p = providersForModel("gemini-2.5-pro")
      expect(p).toContain("google-ai-studio")
      expect(p).toContain("google-gemini-cli")
    })

    it("returns undefined for unknown models", () => {
      expect(providersForModel("unknown-model")).toBeUndefined()
    })
  })

  describe("modelsForProvider", () => {
    it("returns claude models for anthropic provider", () => {
      const models = modelsForProvider("anthropic")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("claude-sonnet-4-5")
      expect(ids).toContain("claude-opus-4-6")
      expect(ids).toContain("claude-haiku-4-5")
      expect(ids).not.toContain("gpt-4o")
    })

    it("returns antigravity contract models for google-antigravity provider", () => {
      const models = modelsForProvider("google-antigravity")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("claude-sonnet-4-5")
      expect(ids).toContain("gemini-3-flash")
      expect(ids).toContain("gpt-oss-120b-medium")
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

  describe("listAllModels", () => {
    it("every entry has id, label, and non-empty providers", () => {
      const all = listAllModels()
      for (const m of all) {
        expect(m.id).toBeTruthy()
        expect(m.label).toBeTruthy()
        expect(m.providers.length).toBeGreaterThan(0)
      }
    })

    it("includes gemini models", () => {
      const ids = listAllModels().map((m) => m.id)
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).toContain("gemini-2.5-flash")
      expect(ids).toContain("gemini-2.0-flash")
    })
  })
})
