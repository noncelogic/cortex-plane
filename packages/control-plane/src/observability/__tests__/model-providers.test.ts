import { describe, expect, it } from "vitest"

import { MODEL_CATALOGUE, modelsForProvider, providersForModel } from "../model-providers.js"

describe("model-providers", () => {
  describe("providersForModel", () => {
    it("returns anthropic + google-antigravity for claude models", () => {
      expect(providersForModel("claude-sonnet-4-6")).toEqual(["anthropic", "google-antigravity"])
      expect(providersForModel("claude-opus-4-6")).toEqual(["anthropic", "google-antigravity"])
      expect(providersForModel("claude-haiku-4-5")).toEqual(["anthropic", "google-antigravity"])
    })

    it("returns openai + openai-codex for gpt models", () => {
      expect(providersForModel("gpt-4o")).toEqual(["openai", "openai-codex"])
      expect(providersForModel("gpt-4o-mini")).toEqual(["openai", "openai-codex"])
    })

    it("returns google-antigravity + google-ai-studio for gemini models", () => {
      expect(providersForModel("gemini-2.5-pro")).toEqual([
        "google-antigravity",
        "google-ai-studio",
      ])
      expect(providersForModel("gemini-2.5-flash")).toEqual([
        "google-antigravity",
        "google-ai-studio",
      ])
      expect(providersForModel("gemini-2.0-flash")).toEqual([
        "google-antigravity",
        "google-ai-studio",
      ])
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
      expect(ids).not.toContain("gemini-2.5-pro")
    })

    it("returns claude + gemini models for google-antigravity provider", () => {
      const models = modelsForProvider("google-antigravity")
      const ids = models.map((m) => m.id)
      expect(ids).toContain("claude-sonnet-4-6")
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).toContain("gemini-2.5-flash")
      expect(ids).toContain("gemini-2.0-flash")
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
      expect(ids).not.toContain("gemini-2.5-pro")
    })

    it("returns empty array for providers with no models", () => {
      expect(modelsForProvider("brave")).toEqual([])
      expect(modelsForProvider("unknown")).toEqual([])
    })
  })

  describe("MODEL_CATALOGUE", () => {
    it("every entry has id, label, and non-empty providers", () => {
      for (const m of MODEL_CATALOGUE) {
        expect(m.id).toBeTruthy()
        expect(m.label).toBeTruthy()
        expect(m.providers.length).toBeGreaterThan(0)
      }
    })

    it("includes gemini models", () => {
      const ids = MODEL_CATALOGUE.map((m) => m.id)
      expect(ids).toContain("gemini-2.5-pro")
      expect(ids).toContain("gemini-2.5-flash")
      expect(ids).toContain("gemini-2.0-flash")
    })
  })
})
