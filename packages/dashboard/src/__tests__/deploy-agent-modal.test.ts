import { describe, expect, it } from "vitest"

import { AVAILABLE_MODELS } from "@/components/agents/deploy-agent-modal"

// ---------------------------------------------------------------------------
// AVAILABLE_MODELS constant
// ---------------------------------------------------------------------------

describe("AVAILABLE_MODELS", () => {
  it("contains at least one model", () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThan(0)
  })

  it("every entry has id, label, and provider", () => {
    for (const m of AVAILABLE_MODELS) {
      expect(typeof m.id).toBe("string")
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.label).toBe("string")
      expect(m.label.length).toBeGreaterThan(0)
      expect(typeof m.provider).toBe("string")
      expect(m.provider.length).toBeGreaterThan(0)
    }
  })

  it("has unique model ids", () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("includes the default fallback model (claude-sonnet-4-6)", () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id)
    expect(ids).toContain("claude-sonnet-4-6")
  })
})

// ---------------------------------------------------------------------------
// model_config construction (mirrors deploy-agent-modal handleSubmit logic)
// ---------------------------------------------------------------------------

describe("model_config construction", () => {
  function buildModelConfig(
    model: string,
    systemPrompt: string,
  ): Record<string, unknown> | undefined {
    const cfg: Record<string, unknown> = {}
    if (model.trim()) cfg.model = model.trim()
    if (systemPrompt.trim()) cfg.systemPrompt = systemPrompt.trim()
    return Object.keys(cfg).length > 0 ? cfg : undefined
  }

  it("includes model when selected", () => {
    const cfg = buildModelConfig("claude-sonnet-4-6", "")
    expect(cfg).toEqual({ model: "claude-sonnet-4-6" })
  })

  it("includes both model and systemPrompt", () => {
    const cfg = buildModelConfig("gpt-4o", "You are a helpful assistant")
    expect(cfg).toEqual({
      model: "gpt-4o",
      systemPrompt: "You are a helpful assistant",
    })
  })

  it("returns undefined when both are empty", () => {
    expect(buildModelConfig("", "")).toBeUndefined()
  })

  it("trims whitespace from model and systemPrompt", () => {
    const cfg = buildModelConfig("  claude-opus-4-6  ", "  Hello  ")
    expect(cfg).toEqual({ model: "claude-opus-4-6", systemPrompt: "Hello" })
  })
})
