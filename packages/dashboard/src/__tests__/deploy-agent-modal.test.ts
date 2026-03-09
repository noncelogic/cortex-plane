import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { AVAILABLE_MODELS } from "@/components/agents/deploy-agent-modal"

const SRC_DIR = path.resolve(__dirname, "..")

function readSrc(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf-8")
}

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

  it("includes anthropic and openai providers", () => {
    const providers = new Set(AVAILABLE_MODELS.map((m) => m.provider))
    expect(providers.has("anthropic")).toBe(true)
    expect(providers.has("openai")).toBe(true)
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

// ---------------------------------------------------------------------------
// Static analysis: deploy modal structure
// ---------------------------------------------------------------------------

describe("Deploy modal structure", () => {
  const content = readSrc("components/agents/deploy-agent-modal.tsx")

  it("has a Model label", () => {
    expect(content).toContain("Model")
  })

  it("has model state", () => {
    expect(content).toContain('useState("")')
    expect(content).toContain("setModel")
  })

  it("uses a select element for model selection", () => {
    expect(content).toContain('data-testid="deploy-model-select"')
  })

  it("exports AVAILABLE_MODELS list", () => {
    expect(content).toContain("AVAILABLE_MODELS")
    expect(content).toContain("claude-sonnet-4-6")
  })

  it("includes model in model_config when building request body", () => {
    expect(content).toContain("modelConfig.model = model.trim()")
  })

  it("includes systemPrompt in model_config when building request body", () => {
    expect(content).toContain("modelConfig.systemPrompt = systemPrompt.trim()")
  })

  it("resets model on form reset", () => {
    expect(content).toContain('setModel("")')
  })

  it("requires model for form submission", () => {
    expect(content).toContain("!model.trim()")
  })

  it("has system prompt textarea", () => {
    expect(content).toContain("System Prompt")
    expect(content).toContain("setSystemPrompt")
  })

  it("shows credential warning when model is selected", () => {
    expect(content).toContain("provider credential")
  })
})
