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

  it("has model input field when editing", () => {
    expect(content).toContain('data-testid="model-config-model-input"')
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
})

// ---------------------------------------------------------------------------
// Static analysis: deploy modal includes model input
// ---------------------------------------------------------------------------

describe("Deploy modal model input", () => {
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

  it("handles API error on update", async () => {
    mockFetchResponse({ error: "Bad Request" }, 400)

    await expect(updateAgent("agt-123", { model_config: { model: "bad-model" } })).rejects.toThrow()
  })
})
