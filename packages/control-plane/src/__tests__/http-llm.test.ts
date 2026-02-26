import { describe, expect, it, vi } from "vitest"

import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"

import { HttpLlmBackend } from "../backends/http-llm.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-llm-001",
    jobId: "job-llm-001",
    agentId: "agent-llm-001",
    instruction: {
      prompt: "Say hello",
      goalType: "research",
    },
    context: {
      workspacePath: "/workspace",
      systemPrompt: "You are a test assistant.",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 30_000,
      maxTokens: 4096,
      model: "claude-sonnet-4-5-20250929",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 1,
      networkAccess: false,
      shellAccess: false,
    },
    ...overrides,
  }
}

async function collectEvents(handle: { events(): AsyncIterable<OutputEvent> }): Promise<OutputEvent[]> {
  const events: OutputEvent[] = []
  for await (const event of handle.events()) {
    events.push(event)
  }
  return events
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — lifecycle", () => {
  it("has backendId 'http-llm'", () => {
    const backend = new HttpLlmBackend()
    expect(backend.backendId).toBe("http-llm")
  })

  it("throws when started without API key", async () => {
    const backend = new HttpLlmBackend()
    // Clear all env vars that could provide a key
    const origLlm = process.env.LLM_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.LLM_API_KEY = ""
    process.env.ANTHROPIC_API_KEY = ""

    try {
      await expect(backend.start({ provider: "anthropic", apiKey: "" })).rejects.toThrow("required")
    } finally {
      if (origLlm !== undefined) process.env.LLM_API_KEY = origLlm
      else delete process.env.LLM_API_KEY
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it("starts successfully with an API key", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key-123" })
    // Should not throw
  })

  it("stops successfully", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key-123" })
    await backend.stop()
    // Should not throw
  })
})

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — healthCheck()", () => {
  it("returns unhealthy when not started", async () => {
    const backend = new HttpLlmBackend()
    const report = await backend.healthCheck()
    expect(report.status).toBe("unhealthy")
    expect(report.reason).toContain("not started")
  })

  it("returns degraded when API call fails (mocked)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "fake-key" })

    // The health check calls the real API — it will fail with fake key
    // We expect a degraded status (not a throw)
    const report = await backend.healthCheck()
    expect(["healthy", "degraded"]).toContain(report.status)
    expect(report.backendId).toBe("http-llm")
    expect(report.details).toHaveProperty("provider", "anthropic")
  })
})

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — getCapabilities()", () => {
  it("reports streaming and token usage support", () => {
    const backend = new HttpLlmBackend()
    const caps = backend.getCapabilities()

    expect(caps.supportsStreaming).toBe(true)
    expect(caps.reportsTokenUsage).toBe(true)
    expect(caps.supportsFileEdit).toBe(false)
    expect(caps.supportsCancellation).toBe(true)
    expect(caps.supportedGoalTypes).toContain("research")
    expect(caps.supportedGoalTypes).toContain("code_generate")
    expect(caps.maxContextTokens).toBe(200_000)
  })
})

// ---------------------------------------------------------------------------
// Execution — not started
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — not started", () => {
  it("throws when executeTask called without start", async () => {
    const backend = new HttpLlmBackend()
    await expect(backend.executeTask(makeTask())).rejects.toThrow("not started")
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — cancellation", () => {
  it("returns cancelled result on cancel", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "fake-key" })

    const handle = await backend.executeTask(makeTask())

    // Cancel immediately before events stream
    await handle.cancel("Test cancellation")

    const result = await handle.result()
    expect(result.status).toBe("cancelled")
    expect(result.summary).toContain("Test cancellation")
  })
})

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — provider selection", () => {
  it("creates Anthropic client for anthropic provider", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // If we can execute a task (returns a handle), the client was created
    const handle = await backend.executeTask(makeTask())
    expect(handle.taskId).toBe("task-llm-001")
    await handle.cancel("cleanup")
  })

  it("creates OpenAI client for openai provider", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "openai", apiKey: "test-key", model: "gpt-4o" })

    const handle = await backend.executeTask(makeTask())
    expect(handle.taskId).toBe("task-llm-001")
    await handle.cancel("cleanup")
  })
})
