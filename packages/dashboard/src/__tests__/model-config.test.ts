import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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

describe("AgentSettingsPanel component", () => {
  const content = readSrc("components/agents/agent-settings-panel.tsx")

  it("renders Agent Settings heading", () => {
    expect(content).toContain("Agent Settings")
  })

  it("includes agent-settings-panel test id", () => {
    expect(content).toContain('data-testid="agent-settings-panel"')
  })

  it("shows model value display with test id", () => {
    expect(content).toContain('data-testid="agent-settings-model-value"')
  })

  it("shows system prompt value display with test id", () => {
    expect(content).toContain('data-testid="agent-settings-prompt-value"')
  })

  it("has edit button with test id", () => {
    expect(content).toContain('data-testid="agent-settings-edit-btn"')
  })

  it("uses a select dropdown for model selection when editing", () => {
    expect(content).toContain('data-testid="agent-settings-model-select"')
    expect(content).toContain("<select")
  })

  it("uses useModels hook for model list in dropdown", () => {
    expect(content).toContain("availableProviderModels.map")
    expect(content).toContain("useModels")
  })

  it("loads bound credentials for provider/model filtering", () => {
    expect(content).toContain("listAgentCredentials")
    expect(content).toContain("boundProviders")
  })

  it("stores model selection as provider::model", () => {
    expect(content).toContain("::")
    expect(content).toContain("makeProviderModelValue")
  })

  it("has system prompt textarea when editing", () => {
    expect(content).toContain('data-testid="agent-settings-prompt"')
  })

  it("has save and cancel buttons", () => {
    expect(content).toContain('data-testid="agent-settings-save-btn"')
    expect(content).toContain('data-testid="agent-settings-cancel-btn"')
  })

  it("shows success toast after save", () => {
    expect(content).toContain("Agent settings saved")
  })

  it("shows error message on failure", () => {
    expect(content).toContain('data-testid="agent-settings-error"')
    expect(content).toContain("Failed to save agent settings")
  })

  it("displays Not set when model or prompt is empty", () => {
    expect(content).toContain("Not set")
  })

  it("calls updateAgent with model_config on save", () => {
    expect(content).toContain("updateAgent(agent.id, {")
  })

  it("writes canonical provider and model ids on save", () => {
    expect(content).toContain("newConfig.provider = provider")
    expect(content).toContain("newConfig.model = model")
  })

  it("displays provider-aware model details in view mode", () => {
    expect(content).toContain("currentProviderModel")
    expect(content).toContain("providerId")
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
    expect(content).toContain("setSelection")
  })

  it("uses a select element for model selection", () => {
    expect(content).toContain('data-testid="deploy-model-select"')
  })

  it("uses useModels hook for dynamic model list", () => {
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
})

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
    const cfg = buildModelConfig(" openai::gpt-4o ", "  Hello  ")
    expect(cfg).toEqual({ provider: "openai", model: "gpt-4o", systemPrompt: "Hello" })
  })
})

// ---------------------------------------------------------------------------
// model_config edit save logic (mirrors AgentSettingsPanel handleSave)
// ---------------------------------------------------------------------------

describe("model_config edit save logic", () => {
  function buildSaveConfig(
    existing: Record<string, unknown>,
    selection: string,
    systemPrompt: string,
  ): Record<string, unknown> {
    const newConfig: Record<string, unknown> = { ...existing }
    const [providerPart, modelPart] = selection.split("::")
    const provider = providerPart?.trim()
    const model = modelPart?.trim()
    if (provider && model) {
      newConfig.provider = provider
      newConfig.model = model
    } else {
      delete newConfig.provider
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
    const result = buildSaveConfig(existing, "openai::gpt-4o", "")
    expect(result).toEqual({ model: "gpt-4o", max_tokens: 4096, provider: "openai" })
  })

  it("removes model when empty", () => {
    const existing = { model: "old-model", max_tokens: 4096 }
    const result = buildSaveConfig(existing, "", "")
    expect(result).toEqual({ max_tokens: 4096 })
  })

  it("sets systemPrompt while preserving model", () => {
    const existing = { provider: "anthropic", model: "claude-sonnet-4-5" }
    const result = buildSaveConfig(existing, "anthropic::claude-sonnet-4-5", "Be helpful")
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      systemPrompt: "Be helpful",
    })
  })

  it("removes systemPrompt when empty", () => {
    const existing = { provider: "openai", model: "gpt-4o", systemPrompt: "old prompt" }
    const result = buildSaveConfig(existing, "openai::gpt-4o", "")
    expect(result).toEqual({ provider: "openai", model: "gpt-4o" })
  })

  it("replaces provider/model pair correctly", () => {
    const existing = {}
    const result = buildSaveConfig(existing, "google-ai-studio::gemini-2.5-pro", "Custom prompt")
    expect(result).toEqual({
      provider: "google-ai-studio",
      model: "gemini-2.5-pro",
      systemPrompt: "Custom prompt",
    })
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
// API client: listModels fetches the model catalogue
// ---------------------------------------------------------------------------

describe("listModels", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches models from GET /models", async () => {
    const catalogue = [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["anthropic"] },
      { id: "gpt-4o", label: "GPT-4o", providers: ["openai"] },
    ]
    mockFetchResponse({
      models: catalogue,
      providerModels: [
        {
          providerId: "anthropic",
          modelId: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          api: "messages",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 8192,
          baseUrl: "https://api.anthropic.com",
        },
      ],
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          description: "Claude models via OAuth",
          authType: "oauth",
          oauthConnectMode: "code_paste",
          credentialClass: "llm_provider",
          isOAuthBacked: true,
          isStaticApiKey: false,
        },
      ],
    })

    const { listModels } = await import("@/lib/api-client")
    const result = await listModels()

    expect(result.models).toHaveLength(2)
    expect(result.models[0]!.id).toBe("claude-sonnet-4-6")

    const fetchMock = vi.mocked(globalThis.fetch)
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toContain("/models")
  })
})

// ---------------------------------------------------------------------------
// Static analysis: useModels hook
// ---------------------------------------------------------------------------

describe("useModels hook", () => {
  const content = readSrc("hooks/use-models.ts")

  it("imports listModels from api-client", () => {
    expect(content).toContain("listModels")
  })

  it("starts with empty model list", () => {
    expect(content).toContain("useState<ModelInfo[]>([])")
  })

  it("returns models and isLoading", () => {
    expect(content).toContain("models")
    expect(content).toContain("isLoading")
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
