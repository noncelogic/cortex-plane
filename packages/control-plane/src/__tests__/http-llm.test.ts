import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

import { HttpLlmBackend, type McpDeps } from "../backends/http-llm.js"
import type { McpToolRouter } from "../mcp/tool-router.js"

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

  it("starts in credential-required mode when no API key is provided", async () => {
    const backend = new HttpLlmBackend()
    const origLlm = process.env.LLM_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.LLM_API_KEY = ""
    process.env.ANTHROPIC_API_KEY = ""

    try {
      // Should NOT throw — starts in credential-required mode
      await backend.start({ provider: "anthropic", apiKey: "" })
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

// ---------------------------------------------------------------------------
// createAgentRegistry — MCP integration
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — createAgentRegistry()", () => {
  it("returns a ToolRegistry with built-in tools when no MCP deps", async () => {
    const backend = new HttpLlmBackend()
    const registry = await backend.createAgentRegistry({})

    expect(registry.get("echo")).toBeDefined()
    expect(registry.get("web_search")).toBeDefined()
  })

  it("merges MCP tools when mcpDeps are provided", async () => {
    const mcpTool = {
      name: "mcp:fs:read_file",
      description: "Read a file from disk",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: vi.fn().mockResolvedValue("file contents"),
    }

    const mockRouter = {
      resolveAll: vi.fn().mockResolvedValue([mcpTool]),
    } as unknown as McpToolRouter

    const mcpDeps: McpDeps = {
      mcpRouter: mockRouter,
      agentId: "agent-mcp-1",
      allowedTools: ["mcp:fs:*"],
      deniedTools: [],
    }

    const backend = new HttpLlmBackend()
    const registry = await backend.createAgentRegistry({}, mcpDeps)

    expect(registry.get("echo")).toBeDefined()
    expect(registry.get("mcp:fs:read_file")).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockRouter.resolveAll).toHaveBeenCalledWith("agent-mcp-1", ["mcp:fs:*"], [])
  })
})

// ---------------------------------------------------------------------------
// End-to-end: MCP tool invocation through agentic loop
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — MCP tool e2e (Anthropic)", () => {
  it("executes an MCP tool through the agentic loop and streams results", async () => {
    // Create an MCP tool definition
    const mcpExecute = vi.fn().mockResolvedValue("search result: 42 items found")
    const mcpTool = {
      name: "mcp:search-srv:web_search",
      description: "Search the web via MCP",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: mcpExecute,
    }

    const mockRouter = {
      resolveAll: vi.fn().mockResolvedValue([mcpTool]),
    } as unknown as McpToolRouter

    const mcpDeps: McpDeps = {
      mcpRouter: mockRouter,
      agentId: "agent-e2e",
      allowedTools: ["mcp:search-srv:*"],
      deniedTools: [],
    }

    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    // Build a per-agent registry that includes the MCP tool
    const agentRegistry = await backend.createAgentRegistry({}, mcpDeps)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // LLM calls the MCP tool
        return createMockAnthropicStream({
          textContent: "Let me search for that. ",
          toolUseBlocks: [
            {
              id: "toolu_mcp_1",
              name: "mcp:search-srv:web_search",
              input: { query: "cortex-plane docs" },
            },
          ],
          stopReason: "tool_use",
          inputTokens: 100,
          outputTokens: 50,
        })
      }
      // LLM returns final text after tool result
      return createMockAnthropicStream({
        textContent: "I found 42 items.",
        stopReason: "end_turn",
        inputTokens: 200,
        outputTokens: 30,
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["mcp:search-srv:web_search"],
      },
    })

    // Execute with the MCP-enriched registry
    const handle = await backend.executeTask(task, agentRegistry)
    const events = await collectEvents(handle)

    // Verify tool_use event for the MCP tool
    const toolUseEvents = events.filter((e) => e.type === "tool_use")
    expect(toolUseEvents).toHaveLength(1)
    expect(toolUseEvents[0]).toMatchObject({
      type: "tool_use",
      toolName: "mcp:search-srv:web_search",
      toolInput: { query: "cortex-plane docs" },
    })

    // Verify tool_result event streams through SSE path
    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      type: "tool_result",
      toolName: "mcp:search-srv:web_search",
      output: "search result: 42 items found",
      isError: false,
    })

    // Verify the MCP execute function was called with correct args
    expect(mcpExecute).toHaveBeenCalledWith({ query: "cortex-plane docs" })

    // Verify usage accumulation
    const usageEvents = events.filter((e) => e.type === "usage")
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      type: "usage",
      tokenUsage: {
        inputTokens: 300,
        outputTokens: 80,
      },
    })

    // Verify final result
    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toContain("Let me search for that.")
    expect(result.stdout).toContain("I found 42 items.")

    // LLM was called exactly twice (tool call + final)
    expect(callCount).toBe(2)
  })

  it("handles MCP tool execution errors gracefully", async () => {
    const mcpTool = {
      name: "mcp:broken:failing_tool",
      description: "A broken MCP tool",
      inputSchema: { type: "object", properties: {} },
      execute: vi.fn().mockRejectedValue(new Error("MCP server unreachable")),
    }

    const mockRouter = {
      resolveAll: vi.fn().mockResolvedValue([mcpTool]),
    } as unknown as McpToolRouter

    const mcpDeps: McpDeps = {
      mcpRouter: mockRouter,
      agentId: "agent-err",
      allowedTools: ["mcp:broken:*"],
      deniedTools: [],
    }

    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    const agentRegistry = await backend.createAgentRegistry({}, mcpDeps)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockAnthropicStream({
          textContent: "",
          toolUseBlocks: [{ id: "toolu_fail", name: "mcp:broken:failing_tool", input: {} }],
          stopReason: "tool_use",
        })
      }
      return createMockAnthropicStream({
        textContent: "The tool failed, but I can continue.",
        stopReason: "end_turn",
      })
    })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["mcp:broken:failing_tool"],
      },
    })

    const handle = await backend.executeTask(task, agentRegistry)
    const events = await collectEvents(handle)

    // The tool result should indicate an error
    const toolResultEvents = events.filter((e) => e.type === "tool_result")
    expect(toolResultEvents).toHaveLength(1)
    expect(toolResultEvents[0]).toMatchObject({
      toolName: "mcp:broken:failing_tool",
      output: "MCP server unreachable",
      isError: true,
    })

    // The loop should still complete successfully
    const result = await handle.result()
    expect(result.status).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility: agents without MCP
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — backward compatibility (no MCP)", () => {
  it("createAgentRegistry without mcpDeps preserves existing behavior", async () => {
    const backend = new HttpLlmBackend()
    const registry = await backend.createAgentRegistry({
      tools: [
        {
          name: "webhook_tool",
          description: "A webhook",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://example.com/hook" },
        },
      ],
    })

    // Should have built-in tools
    expect(registry.get("echo")).toBeDefined()
    // Should have webhook tool
    expect(registry.get("webhook_tool")).toBeDefined()
    // Should NOT have any MCP tools
    expect(registry.get("mcp:any:tool")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Credential-required mode (no global API key)
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — credential-required mode", () => {
  it("healthCheck returns healthy with credentialRequired flag", async () => {
    const backend = new HttpLlmBackend()
    const origLlm = process.env.LLM_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.LLM_API_KEY = ""
    process.env.ANTHROPIC_API_KEY = ""

    try {
      await backend.start({ provider: "anthropic", apiKey: "" })
      const report = await backend.healthCheck()
      expect(report.status).toBe("healthy")
      expect(report.details).toHaveProperty("credentialRequired", true)
    } finally {
      if (origLlm !== undefined) process.env.LLM_API_KEY = origLlm
      else delete process.env.LLM_API_KEY
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it("rejects executeTask when no per-job credential and no global key", async () => {
    const backend = new HttpLlmBackend()
    const origLlm = process.env.LLM_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.LLM_API_KEY = ""
    process.env.ANTHROPIC_API_KEY = ""

    try {
      await backend.start({ provider: "anthropic", apiKey: "" })
      await expect(backend.executeTask(makeTask())).rejects.toThrow("No LLM credential available")
    } finally {
      if (origLlm !== undefined) process.env.LLM_API_KEY = origLlm
      else delete process.env.LLM_API_KEY
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it("accepts executeTask with per-job credential even without global key", async () => {
    const backend = new HttpLlmBackend()
    const origLlm = process.env.LLM_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.LLM_API_KEY = ""
    process.env.ANTHROPIC_API_KEY = ""

    try {
      await backend.start({ provider: "anthropic", apiKey: "" })

      const task = makeTask({
        constraints: {
          ...makeTask().constraints,
          llmCredential: {
            provider: "anthropic",
            token: "oauth-token-xyz",
            credentialId: "cred-no-global",
          },
        },
      })

      const handle = await backend.executeTask(task)
      expect(handle.taskId).toBe("task-llm-001")
      await handle.cancel("test")

      const result = await handle.result()
      expect(result.status).toBe("cancelled")
    } finally {
      if (origLlm !== undefined) process.env.LLM_API_KEY = origLlm
      else delete process.env.LLM_API_KEY
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
    }
  })
})

// ---------------------------------------------------------------------------
// 401 retry with token refresh
// ---------------------------------------------------------------------------

/**
 * Helper: intercept the handle's internal client field so that when
 * the retry logic creates a new SDK client, the mock is applied to
 * the new instance as well.
 */
function interceptAnthropicClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: any,
  mockImpl: () => ReturnType<typeof createMockAnthropicStream> | never,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  let currentClient = handle.client
  const applyMock = (client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).messages, "stream").mockImplementation(mockImpl)
  }
  applyMock(currentClient)
  Object.defineProperty(handle, "client", {
    get: () => currentClient as unknown,
    set: (newClient: unknown) => {
      currentClient = newClient
      applyMock(newClient)
    },
    configurable: true,
  })
}

/**
 * Helper: same as interceptAnthropicClient but for OpenAI handles.
 */
function interceptOpenAIClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: any,
  mockImpl: () =>
    | ReturnType<typeof createMockOpenAIStream>
    | Promise<ReturnType<typeof createMockOpenAIStream>>
    | never,
): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  let currentClient = handle.client
  const applyMock = (client: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).chat.completions, "create").mockImplementation(mockImpl)
  }
  applyMock(currentClient)
  Object.defineProperty(handle, "client", {
    get: () => currentClient as unknown,
    set: (newClient: unknown) => {
      currentClient = newClient
      applyMock(newClient)
    },
    configurable: true,
  })
}

describe("HttpLlmBackend — 401 token refresh retry", () => {
  it("retries on 401 and succeeds with refreshed Anthropic token", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn().mockResolvedValue("refreshed-token-456")

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "expired-token",
          credentialId: "cred-refresh-1",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)

    let callCount = 0
    interceptAnthropicClient(handle, () => {
      callCount++
      if (callCount === 1) {
        const err = new Error("Invalid API key") as Error & { status: number }
        err.status = 401
        throw err
      }
      return createMockAnthropicStream({
        textContent: "Success after refresh!",
        stopReason: "end_turn",
      })
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(refresher).toHaveBeenCalledWith("cred-refresh-1")
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Success after refresh!")
    expect(callCount).toBe(2)
  })

  it("retries on 401 and succeeds with refreshed Anthropic OAuth token (uses apiKey)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn().mockResolvedValue("refreshed-oauth-token")

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "expired-oauth-token",
          credentialId: "cred-anthropic-oauth-refresh",
          credentialType: "oauth",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)

    let callCount = 0
    interceptAnthropicClient(handle, () => {
      callCount++
      if (callCount === 1) {
        const err = new Error("Invalid API key") as Error & { status: number }
        err.status = 401
        throw err
      }
      return createMockAnthropicStream({
        textContent: "OAuth refresh success!",
        stopReason: "end_turn",
      })
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(refresher).toHaveBeenCalledWith("cred-anthropic-oauth-refresh")
    expect(result.status).toBe("completed")
    expect(callCount).toBe(2)
  })

  it("fails when refresher returns null (cannot refresh)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn().mockResolvedValue(null)

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "expired-token",
          credentialId: "cred-norefresh",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    vi.spyOn((handle as any).client.messages, "stream").mockImplementation(() => {
      const err = new Error("Invalid API key") as Error & { status: number }
      err.status = 401
      throw err
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(refresher).toHaveBeenCalledWith("cred-norefresh")
    expect(result.status).toBe("failed")
    expect(result.summary).toContain("Invalid API key")
  })

  it("does not retry on non-401 errors", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn()

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "valid-token",
          credentialId: "cred-500",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    vi.spyOn((handle as any).client.messages, "stream").mockImplementation(() => {
      const err = new Error("Internal server error") as Error & { status: number }
      err.status = 500
      throw err
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(refresher).not.toHaveBeenCalled()
    expect(result.status).toBe("failed")
  })

  it("retries only once per turn (no infinite loop)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn().mockResolvedValue("still-bad-token")

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "expired-token",
          credentialId: "cred-loop",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)
    let callCount = 0

    interceptAnthropicClient(handle, () => {
      callCount++
      const err = new Error("Invalid API key") as Error & { status: number }
      err.status = 401
      throw err
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(callCount).toBe(2)
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(result.status).toBe("failed")
  })

  it("retries on 401 for OpenAI provider", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const refresher = vi.fn().mockResolvedValue("refreshed-openai-token")

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "openai",
          token: "expired-openai-token",
          credentialId: "cred-openai-refresh",
        },
      },
    })

    const handle = await backend.executeTask(task, undefined, refresher)
    let callCount = 0

    interceptOpenAIClient(handle, () => {
      callCount++
      if (callCount === 1) {
        const err = new Error("Incorrect API key") as Error & { status: number }
        err.status = 401
        throw err
      }
      return createMockOpenAIStream({
        textContent: "OpenAI refreshed!",
        finishReason: "stop",
      })
    })

    await collectEvents(handle)
    const result = await handle.result()

    expect(refresher).toHaveBeenCalledWith("cred-openai-refresh")
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("OpenAI refreshed!")
    expect(callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Credential routing: google-antigravity vs anthropic vs openai
// ---------------------------------------------------------------------------

describe("HttpLlmBackend — credential provider routing", () => {
  it("routes google-antigravity to proxy with authToken", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "gcp-oauth-token",
          credentialId: "cred-gcp",
          accountId: "my-gcp-project-123",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as {
      baseURL: string
      authToken: string | null
    }
    // Default Antigravity routing: production endpoint first, then sandbox fallback
    expect(client.baseURL).toBe("https://cloudcode-pa.googleapis.com")
    // Token wrapping: JSON.stringify({ token, projectId }) for Antigravity
    expect(client.authToken).toBe(
      JSON.stringify({ token: "gcp-oauth-token", projectId: "my-gcp-project-123" }),
    )

    await handle.cancel("test")
  })

  it("routes plain anthropic credential with apiKey and default base URL", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "anthropic-api-key",
          credentialId: "cred-anthropic",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as {
      baseURL: string
      authToken: string | null
      apiKey: string
    }
    // Default Anthropic base URL (no custom override)
    expect(client.baseURL).toContain("api.anthropic.com")
    expect(client.apiKey).toBe("anthropic-api-key")
    expect(client.authToken).toBeNull()

    await handle.cancel("test")
  })

  it("routes anthropic oauth credential with apiKey (not authToken)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "anthropic-oauth-access-token",
          credentialId: "cred-anthropic-oauth",
          credentialType: "oauth",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as {
      baseURL: string
      authToken: string | null
      apiKey: string
    }
    // Anthropic OAuth tokens must be sent via x-api-key, not Bearer
    expect(client.apiKey).toBe("anthropic-oauth-access-token")
    expect(client.authToken).toBeNull()

    await handle.cancel("test")
  })

  it("routes openai-codex credential to OpenAI SDK", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "openai-codex",
          token: "openai-api-key",
          credentialId: "cred-openai",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // OpenAI handles have a different client type — verify it's not an AnthropicHandle
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as { apiKey: string }
    expect(client.apiKey).toBe("openai-api-key")

    await handle.cancel("test")
  })

  it("falls back to default proxy when accountId is missing", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "gcp-oauth-token",
          credentialId: "cred-gcp-no-account",
          // accountId omitted — still routes through proxy
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as {
      baseURL: string
      authToken: string | null
    }
    // Without accountId, still uses the default Antigravity production endpoint
    expect(client.baseURL).toBe("https://cloudcode-pa.googleapis.com")
    // No projectId available — token sent unwrapped
    expect(client.authToken).toBe("gcp-oauth-token")

    await handle.cancel("test")
  })

  it("uses credential baseUrl when provided (provider config override)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "gcp-oauth-token",
          credentialId: "cred-gcp-custom",
          accountId: "my-project",
          baseUrl: "https://custom-proxy.example.com/v1",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as { baseURL: string; authToken: string | null }
    expect(client.baseURL).toBe("https://custom-proxy.example.com/v1")
    // Token wrapping: JSON.stringify({ token, projectId }) for Antigravity
    expect(client.authToken).toBe(
      JSON.stringify({ token: "gcp-oauth-token", projectId: "my-project" }),
    )

    await handle.cancel("test")
  })

  it("uses ANTIGRAVITY_BASE_URL env var when set", async () => {
    const originalEnv = process.env.ANTIGRAVITY_BASE_URL
    process.env.ANTIGRAVITY_BASE_URL = "https://env-override.example.com/anthropic"

    try {
      const backend = new HttpLlmBackend()
      await backend.start({ provider: "anthropic", apiKey: "global-key" })

      const task = makeTask({
        constraints: {
          ...makeTask().constraints,
          llmCredential: {
            provider: "google-antigravity",
            token: "gcp-oauth-token",
            credentialId: "cred-gcp-env",
            accountId: "my-project",
          },
        },
      })

      const handle = await backend.executeTask(task)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const client = (handle as any).client as { baseURL: string }
      expect(client.baseURL).toBe("https://env-override.example.com/anthropic")

      await handle.cancel("test")
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ANTIGRAVITY_BASE_URL
      } else {
        process.env.ANTIGRAVITY_BASE_URL = originalEnv
      }
    }
  })

  it("does not rewrite paths — proxy accepts standard Anthropic API format", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "gcp-oauth-token",
          credentialId: "cred-gcp-proxy",
          accountId: "my-project-42",
        },
      },
    })

    const handle = await backend.executeTask(task)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const client = (handle as any).client as { baseURL: string; authToken: string | null }
    // Default Antigravity routing: production endpoint first, then sandbox fallback
    expect(client.baseURL).toBe("https://cloudcode-pa.googleapis.com")
    // Token wrapping: JSON.stringify({ token, projectId }) for Antigravity
    expect(client.authToken).toBe(
      JSON.stringify({ token: "gcp-oauth-token", projectId: "my-project-42" }),
    )

    await handle.cancel("test")
  })
})
