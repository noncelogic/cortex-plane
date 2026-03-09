import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { AVAILABLE_MODELS } from "@/components/agents/deploy-agent-modal"
import { updateAgent } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  )
}

const SRC_DIR = path.resolve(__dirname, "..")

function readSrc(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf-8")
}

// ---------------------------------------------------------------------------
// Static analysis: agent detail page contains model config section
// ---------------------------------------------------------------------------

describe("ModelConfigPanel in agent detail page", () => {
  const content = readSrc("app/agents/[agentId]/page.tsx")

  it("renders Model Configuration heading", () => {
    expect(content).toContain("Model Configuration")
  })

  it("includes model-config-panel test id", () => {
    expect(content).toContain('data-testid="model-config-panel"')
  })

  it("shows model value display with test id", () => {
    expect(content).toContain('data-testid="model-config-model-value"')
  })

  it("shows system prompt value display with test id", () => {
    expect(content).toContain('data-testid="model-config-prompt-value"')
  })

  it("has edit button with test id", () => {
    expect(content).toContain('data-testid="model-config-edit-btn"')
  })

  it("uses a select dropdown for model selection when editing", () => {
    expect(content).toContain('data-testid="model-config-model-select"')
    expect(content).toContain("<select")
  })

  it("includes AVAILABLE_MODELS options in dropdown", () => {
    expect(content).toContain("AVAILABLE_MODELS.map")
    expect(content).toContain("import { AVAILABLE_MODELS }")
  })

  it("offers a Custom option in the model dropdown", () => {
    expect(content).toContain("Custom...")
    expect(content).toContain("CUSTOM_MODEL_VALUE")
  })

  it("shows custom text input when Custom is selected", () => {
    expect(content).toContain('data-testid="model-config-model-input"')
    expect(content).toContain("model === CUSTOM_MODEL_VALUE")
  })

  it("has system prompt textarea when editing", () => {
    expect(content).toContain('data-testid="model-config-prompt-input"')
  })

  it("has save and cancel buttons", () => {
    expect(content).toContain('data-testid="model-config-save-btn"')
    expect(content).toContain('data-testid="model-config-cancel-btn"')
  })

  it("shows success toast after save", () => {
    expect(content).toContain("Model configuration saved")
  })

  it("shows error message on failure", () => {
    expect(content).toContain('data-testid="model-config-error"')
    expect(content).toContain("Failed to save model configuration")
  })

  it("displays Not set when model or prompt is empty", () => {
    expect(content).toContain("Not set")
  })

  it("calls updateAgent with model_config on save", () => {
    expect(content).toContain("updateAgent(agent.id, { model_config:")
  })

  it("resolves custom model value before saving", () => {
    expect(content).toContain("resolvedModel")
    // Ensures __custom__ sentinel is never sent to the API
    expect(content).toContain("model === CUSTOM_MODEL_VALUE ? customModel.trim() : model.trim()")
  })

  it("displays model label for known models in view mode", () => {
    expect(content).toContain("modelLabel")
    expect(content).toContain("AVAILABLE_MODELS.find")
  })

  it("pre-selects Custom when current model is not in AVAILABLE_MODELS", () => {
    expect(content).toContain("isKnownModel")
    expect(content).toContain("AVAILABLE_MODELS.some")
  })
})

// ---------------------------------------------------------------------------
// Static analysis: deploy modal includes model selector
// ---------------------------------------------------------------------------

describe("Deploy modal model selector", () => {
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
})

// ---------------------------------------------------------------------------
// AVAILABLE_MODELS constant validation
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

// ---------------------------------------------------------------------------
// model_config edit save logic (mirrors ModelConfigPanel handleSave)
// ---------------------------------------------------------------------------

describe("model_config edit save logic", () => {
  function buildSaveConfig(
    existing: Record<string, unknown>,
    resolvedModel: string,
    systemPrompt: string,
  ): Record<string, unknown> {
    const newConfig: Record<string, unknown> = { ...existing }
    if (resolvedModel) {
      newConfig.model = resolvedModel
    } else {
      delete newConfig.model
    }
    if (systemPrompt.trim()) {
      newConfig.systemPrompt = systemPrompt.trim()
    } else {
      delete newConfig.systemPrompt
    }
    return newConfig
  }

  it("updates model while preserving other fields", () => {
    const existing = { model: "old-model", max_tokens: 4096, provider: "anthropic" }
    const result = buildSaveConfig(existing, "claude-opus-4-6", "")
    expect(result).toEqual({ model: "claude-opus-4-6", max_tokens: 4096, provider: "anthropic" })
  })

  it("removes model when empty", () => {
    const existing = { model: "old-model", max_tokens: 4096 }
    const result = buildSaveConfig(existing, "", "")
    expect(result).toEqual({ max_tokens: 4096 })
  })

  it("sets systemPrompt while preserving model", () => {
    const existing = { model: "claude-sonnet-4-6" }
    const result = buildSaveConfig(existing, "claude-sonnet-4-6", "Be helpful")
    expect(result).toEqual({ model: "claude-sonnet-4-6", systemPrompt: "Be helpful" })
  })

  it("removes systemPrompt when empty", () => {
    const existing = { model: "gpt-4o", systemPrompt: "old prompt" }
    const result = buildSaveConfig(existing, "gpt-4o", "")
    expect(result).toEqual({ model: "gpt-4o" })
  })

  it("handles custom model id correctly", () => {
    const existing = {}
    const result = buildSaveConfig(existing, "custom-model-v2", "Custom prompt")
    expect(result).toEqual({ model: "custom-model-v2", systemPrompt: "Custom prompt" })
  })
})

// ---------------------------------------------------------------------------
// Custom model resolution logic (mirrors CUSTOM_MODEL_VALUE sentinel)
// ---------------------------------------------------------------------------

describe("custom model resolution", () => {
  const CUSTOM_MODEL_VALUE = "__custom__"

  function resolveModel(model: string, customModel: string): string {
    return model === CUSTOM_MODEL_VALUE ? customModel.trim() : model.trim()
  }

  it("returns selected model when not custom", () => {
    expect(resolveModel("claude-sonnet-4-6", "")).toBe("claude-sonnet-4-6")
  })

  it("returns custom model when custom sentinel is selected", () => {
    expect(resolveModel(CUSTOM_MODEL_VALUE, "my-custom-model")).toBe("my-custom-model")
  })

  it("trims whitespace from custom model", () => {
    expect(resolveModel(CUSTOM_MODEL_VALUE, "  spaced-model  ")).toBe("spaced-model")
  })

  it("returns empty string when custom is selected but no value entered", () => {
    expect(resolveModel(CUSTOM_MODEL_VALUE, "")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// API client: updateAgent sends model_config
// ---------------------------------------------------------------------------

describe("updateAgent with model_config", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("sends model_config in PUT body", async () => {
    mockFetchResponse({})

    await updateAgent("agt-123", {
      model_config: { model: "claude-opus-4-6-thinking", systemPrompt: "Be helpful" },
    })

    const fetchMock = vi.mocked(globalThis.fetch)
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain("/agents/agt-123")
    expect(init?.method).toBe("PUT")

    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    const mc = body.model_config as Record<string, unknown>
    expect(mc.model).toBe("claude-opus-4-6-thinking")
    expect(mc.systemPrompt).toBe("Be helpful")
  })

  it("sends model_config with only model (no systemPrompt)", async () => {
    mockFetchResponse({})

    await updateAgent("agt-456", {
      model_config: { model: "gpt-4o" },
    })

    const fetchMock = vi.mocked(globalThis.fetch)
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    const mc = body.model_config as Record<string, unknown>
    expect(mc.model).toBe("gpt-4o")
    expect(mc.systemPrompt).toBeUndefined()
  })

  it("handles API error on update", async () => {
    mockFetchResponse({ error: "Bad Request" }, 400)

    await expect(updateAgent("agt-123", { model_config: { model: "bad-model" } })).rejects.toThrow()
  })
})
