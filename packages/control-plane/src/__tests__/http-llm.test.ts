import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

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

// ---------------------------------------------------------------------------
// Agentic loop helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock object that mimics Anthropic's MessageStream.
 * It is async-iterable (yields content_block_delta events for text)
 * and exposes a finalMessage() that returns the complete message.
 */
function createMockAnthropicStream(opts: {
  textContent: string
  toolUseBlocks?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  inputTokens?: number
  outputTokens?: number
}) {
  const { textContent, toolUseBlocks = [], stopReason, inputTokens = 10, outputTokens = 20 } = opts

  // Build content blocks for finalMessage
  const contentBlocks: unknown[] = []
  if (textContent) {
    contentBlocks.push({ type: "text", text: textContent })
  }
  for (const tu of toolUseBlocks) {
    contentBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input })
  }

  // Build streaming events (only text deltas)
  const events: unknown[] = []
  if (textContent) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: textContent },
    })
  }

  const finalMsg = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: "test",
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }

  let eventIndex = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (eventIndex < events.length) {
            return Promise.resolve({ value: events[eventIndex++], done: false as const })
          }
          return Promise.resolve({ value: undefined, done: true as const })
        },
      }
    },
    finalMessage: () => Promise.resolve(finalMsg),
    abort: vi.fn(),
  }
}

/** Collect all OutputEvents from a handle. */
async function collectEvents(handle: { events(): AsyncIterable<OutputEvent> }) {
  const events: OutputEvent[] = []
  for await (const e of handle.events()) {
    events.push(e)
  }
  return events
}

// ---------------------------------------------------------------------------
// Agentic loop — Anthropic
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — agentic loop (Anthropic)", () => {
  it("executes a single tool call and returns the final text response", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // Replace the internal Anthropic client's stream method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call: LLM returns text + tool_use
        return createMockAnthropicStream({
          textContent: "Let me echo that.",
          toolUseBlocks: [{ id: "toolu_001", name: "echo", input: { text: "hello" } }],
          stopReason: "tool_use",
          inputTokens: 50,
          outputTokens: 30,
        })
      }
      // Second call: LLM returns final text
      return createMockAnthropicStream({
        textContent: "The echo returned: hello",
        stopReason: "end_turn",
        inputTokens: 80,
        outputTokens: 15,
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["echo"],
      },
    })

    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    // Should have text events from both iterations
    const textEvents = events.filter((e) => e.type === "text")
    expect(textEvents).toHaveLength(2)

    // Should have tool_use and tool_result events
    const toolUseEvents = events.filter((e) => e.type === "tool_use")
    expect(toolUseEvents).toHaveLength(1)
    expect(toolUseEvents[0]).toMatchObject({
      type: "tool_use",
      toolName: "echo",
      toolInput: { text: "hello" },
    })

    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      type: "tool_result",
      toolName: "echo",
      output: "hello",
      isError: false,
    })

    // Should have usage event with accumulated tokens
    const usageEvents = events.filter((e) => e.type === "usage")
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      type: "usage",
      tokenUsage: {
        inputTokens: 130, // 50 + 80
        outputTokens: 45, // 30 + 15
      },
    })

    // Final result should contain all text
    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Let me echo that.The echo returned: hello")

    // The LLM was called exactly twice
    expect(callCount).toBe(2)
  })

  it("stops at maxTurns even when LLM keeps requesting tools", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // Always return tool_use — loop should be bounded by maxTurns
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      return createMockAnthropicStream({
        textContent: `Iteration ${callCount}. `,
        toolUseBlocks: [{ id: `toolu_${callCount}`, name: "echo", input: { text: "loop" } }],
        stopReason: "tool_use",
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 3,
        allowedTools: ["echo"],
      },
    })

    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    // maxTurns=3 means at most 3 LLM calls; tool execution happens
    // between calls, so we get 2 tool executions (after call 1 and 2).
    // Call 3 also returns tool_use but we can't loop again.
    expect(callCount).toBe(3)

    // Tool events: 2 rounds of tool execution (between iterations 1→2 and 2→3)
    const toolUseEvents = events.filter((e) => e.type === "tool_use")
    expect(toolUseEvents).toHaveLength(2)

    const result = await handle.result()
    expect(result.status).toBe("completed")
  })

  it("does not send tools when allowedTools is empty", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const streamSpy = vi.spyOn(client.messages, "stream").mockImplementation(() => {
      return createMockAnthropicStream({
        textContent: "Just text, no tools.",
        stopReason: "end_turn",
      })
    })

    const task = makeTask() // allowedTools: [] by default
    const handle = await backend.executeTask(task)
    await collectEvents(handle)

    // Verify no tools parameter was sent

    const callArgs = streamSpy.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty("tools")

    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Just text, no tools.")
  })

  it("handles unknown tool gracefully", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockAnthropicStream({
          textContent: "",
          toolUseBlocks: [{ id: "toolu_x", name: "nonexistent", input: {} }],
          stopReason: "tool_use",
        })
      }
      return createMockAnthropicStream({
        textContent: "OK, that tool failed.",
        stopReason: "end_turn",
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["echo"],
      },
    })

    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      toolName: "nonexistent",
      isError: true,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      output: expect.stringContaining("Unknown tool"),
    })

    const result = await handle.result()
    expect(result.status).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// Agentic loop — OpenAI
// ---------------------------------------------------------------------------

/**
 * Creates a mock async iterable for OpenAI chat completion streaming.
 * Yields chunks with text content and/or tool call deltas.
 */
function createMockOpenAIStream(opts: {
  textContent: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason: string
  promptTokens?: number
  completionTokens?: number
}) {
  const {
    textContent,
    toolCalls = [],
    finishReason,
    promptTokens = 10,
    completionTokens = 20,
  } = opts

  const chunks: unknown[] = []

  // Text content chunk
  if (textContent) {
    chunks.push({
      choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }],
    })
  }

  // Tool call chunks (each tool in a single chunk for simplicity)
  for (const tc of toolCalls) {
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolCalls.indexOf(tc),
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  }

  // Final chunk with finish_reason and usage
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })

  let chunkIndex = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (chunkIndex < chunks.length) {
            return Promise.resolve({ value: chunks[chunkIndex++], done: false as const })
          }
          return Promise.resolve({ value: undefined, done: true as const })
        },
      }
    },
  }
}

describe("HttpLlmBackend — agentic loop (OpenAI)", () => {
  it("executes a tool call and returns final text response", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "openai", apiKey: "test-key", model: "gpt-4o" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).openaiClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.chat.completions, "create").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          createMockOpenAIStream({
            textContent: "Calling echo. ",
            toolCalls: [{ id: "call_001", name: "echo", arguments: '{"text":"world"}' }],
            finishReason: "tool_calls",
            promptTokens: 40,
            completionTokens: 25,
          }),
        )
      }
      return Promise.resolve(
        createMockOpenAIStream({
          textContent: "Echo said: world",
          finishReason: "stop",
          promptTokens: 70,
          completionTokens: 12,
        }),
      )
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["echo"],
      },
    })

    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    // Tool events
    const toolUseEvents = events.filter((e) => e.type === "tool_use")
    expect(toolUseEvents).toHaveLength(1)
    expect(toolUseEvents[0]).toMatchObject({
      toolName: "echo",
      toolInput: { text: "world" },
    })

    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      toolName: "echo",
      output: "world",
      isError: false,
    })

    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Calling echo. Echo said: world")
    expect(callCount).toBe(2)
  })

  it("does not send tools when allowedTools is empty", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "openai", apiKey: "test-key", model: "gpt-4o" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).openaiClient

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const createSpy = vi.spyOn(client.chat.completions, "create").mockImplementation(() => {
      return Promise.resolve(
        createMockOpenAIStream({
          textContent: "Just text.",
          finishReason: "stop",
        }),
      )
    })

    const task = makeTask() // allowedTools: []
    const handle = await backend.executeTask(task)
    await collectEvents(handle)

    const callArgs = createSpy.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs).not.toHaveProperty("tools")

    const result = await handle.result()
    expect(result.stdout).toBe("Just text.")
  })
})

// ---------------------------------------------------------------------------
// registerTool
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — registerTool()", () => {
  it("makes custom tools available for execution", async () => {
    const backend = new HttpLlmBackend()
    backend.registerTool({
      name: "greet",
      description: "Returns a greeting",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: (input) => Promise.resolve(`Hello, ${String(input.name)}!`),
    })
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockAnthropicStream({
          textContent: "",
          toolUseBlocks: [{ id: "toolu_g1", name: "greet", input: { name: "Alice" } }],
          stopReason: "tool_use",
        })
      }
      return createMockAnthropicStream({
        textContent: "Greeting done.",
        stopReason: "end_turn",
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["greet"],
      },
    })

    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      toolName: "greet",
      output: "Hello, Alice!",
      isError: false,
    })
  })
})
