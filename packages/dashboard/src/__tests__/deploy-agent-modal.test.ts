import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC_DIR = path.resolve(__dirname, "..")

function readSrc(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf-8")
}

// ---------------------------------------------------------------------------
// model_config construction (mirrors deploy-agent-modal handleSubmit logic)
// ---------------------------------------------------------------------------

describe("model_config construction", () => {
  function buildModelConfig(
    selection: string,
    systemPrompt: string,
  ): Record<string, unknown> | undefined {
    const cfg: Record<string, unknown> = {}
    const [providerPart, modelPart] = selection.split("::")
    const provider = providerPart?.trim()
    const model = modelPart?.trim()
    if (provider && model) {
      cfg.provider = provider
      cfg.model = model
    }
    if (systemPrompt.trim()) cfg.systemPrompt = systemPrompt.trim()
    return Object.keys(cfg).length > 0 ? cfg : undefined
  }

  it("includes model when selected", () => {
    const cfg = buildModelConfig("anthropic::claude-sonnet-4-5", "")
    expect(cfg).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" })
  })

  it("includes both model and systemPrompt", () => {
    const cfg = buildModelConfig("openai::gpt-4o", "You are a helpful assistant")
    expect(cfg).toEqual({
      provider: "openai",
      model: "gpt-4o",
      systemPrompt: "You are a helpful assistant",
    })
  })

  it("returns undefined when both are empty", () => {
    expect(buildModelConfig("", "")).toBeUndefined()
  })

  it("trims whitespace from model and systemPrompt", () => {
    const cfg = buildModelConfig("openai::gpt-4o", "  Hello  ")
    expect(cfg).toEqual({ provider: "openai", model: "gpt-4o", systemPrompt: "Hello" })
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
    expect(content).toContain("setSelection")
  })

  it("uses a select element for model selection", () => {
    expect(content).toContain('data-testid="deploy-model-select"')
  })

  it("uses useModels hook for dynamic model fetching", () => {
    expect(content).toContain("useModels")
    expect(content).toContain("providerModels")
  })

  it("shows empty state when no models available", () => {
    expect(content).toContain("No models available")
    expect(content).toContain("Connect a provider")
  })

  it("includes model in model_config when building request body", () => {
    expect(content).toContain("modelConfig.provider = provider")
    expect(content).toContain("modelConfig.model = model")
  })

  it("includes systemPrompt in model_config when building request body", () => {
    expect(content).toContain("modelConfig.systemPrompt = systemPrompt.trim()")
  })

  it("resets model on form reset", () => {
    expect(content).toContain('setSelection("")')
  })

  it("requires model for form submission", () => {
    expect(content).toContain("!selection.trim()")
  })

  it("has system prompt textarea", () => {
    expect(content).toContain("System Prompt")
    expect(content).toContain("setSystemPrompt")
  })

  it("filters models by selected credential provider", () => {
    expect(content).toContain("selectedCredential")
    expect(content).toContain("providerModel.providerId === selectedCredential.provider")
  })
})
