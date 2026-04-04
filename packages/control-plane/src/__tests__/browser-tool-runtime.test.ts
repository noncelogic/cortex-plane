import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

import { HttpLlmBackend } from "../backends/http-llm.js"
import { BrowserActionError } from "../observation/service.js"

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-browser-001",
    jobId: "job-browser-001",
    agentId: "agent-1",
    instruction: {
      prompt: "Open example.com in the browser",
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
      allowedTools: ["playwright_navigate"],
      deniedTools: [],
      maxTurns: 3,
      networkAccess: true,
      shellAccess: false,
    },
    ...overrides,
  }
}

function createMockAnthropicStream(opts: {
  textContent: string
  toolUseBlocks?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: string
  inputTokens?: number
  outputTokens?: number
}) {
  const { textContent, toolUseBlocks = [], stopReason, inputTokens = 10, outputTokens = 20 } = opts

  const contentBlocks: unknown[] = []
  if (textContent) {
    contentBlocks.push({ type: "text", text: textContent })
  }
  for (const tool of toolUseBlocks) {
    contentBlocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input })
  }

  const events: unknown[] = textContent
    ? [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: textContent },
        },
      ]
    : []

  const finalMessage = {
    id: "msg-browser-test",
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
    finalMessage: () => Promise.resolve(finalMessage),
    abort: vi.fn(),
  }
}

async function collectEvents(handle: { events(): AsyncIterable<OutputEvent> }) {
  const events: OutputEvent[] = []
  for await (const event of handle.events()) {
    events.push(event)
  }
  return events
}

function makeDbRecorder() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = []

  return {
    db: {
      insertInto: vi.fn().mockImplementation((table: string) => ({
        values: (values: Record<string, unknown>) => ({
          execute: vi.fn().mockImplementation(() => {
            inserts.push({ table, values })
            return Promise.resolve([])
          }),
        }),
      })),
    },
    inserts,
  }
}

describe("browser tool runtime", () => {
  it("executes playwright_navigate through the standard agent tool loop", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    const navigate = vi.fn().mockResolvedValue({
      agentId: "agent-1",
      url: "https://example.com/",
      title: "Example Domain",
      timestamp: "2026-04-04T00:00:00.000Z",
      session: {
        agentId: "agent-1",
        status: "connected",
        sessionId: "session-1",
        targetId: "target-1",
        currentUrl: "https://example.com/",
        currentTitle: "Example Domain",
        errorMessage: null,
        lastHeartbeat: "2026-04-04T00:00:00.000Z",
      },
      tabs: [{ index: 0, url: "https://example.com/", title: "Example Domain", active: true }],
    })
    const captureScreenshot = vi.fn().mockResolvedValue({
      agentId: "agent-1",
      data: "abc123",
      format: "jpeg",
      width: 1280,
      height: 720,
      timestamp: "2026-04-04T00:00:01.000Z",
      url: "https://example.com/",
      title: "Example Domain",
    })
    const observationService = {
      navigate,
      captureScreenshot,
    }
    const { db, inserts } = makeDbRecorder()

    const registry = await backend.createAgentRegistry(
      {},
      {
        agentId: "agent-1",
        allowedTools: ["playwright_navigate"],
        deniedTools: [],
        browser: {
          db: db as never,
          observationService: observationService as never,
        },
      },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockAnthropicStream({
          textContent: "Opening the page.",
          toolUseBlocks: [
            {
              id: "toolu_browser_1",
              name: "playwright_navigate",
              input: { url: "https://example.com" },
            },
          ],
          stopReason: "tool_use",
        })
      }
      return createMockAnthropicStream({
        textContent: "The browser loaded the page successfully.",
        stopReason: "end_turn",
      })
    })

    const handle = await backend.executeTask(makeTask(), registry)
    const events = await collectEvents(handle)

    const toolResult = events.find(
      (event): event is Extract<OutputEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    )
    expect(toolResult).toBeDefined()
    expect(toolResult?.toolName).toBe("playwright_navigate")
    expect(toolResult?.isError).toBe(false)
    expect(toolResult?.output).toContain('"ok": true')
    expect(toolResult?.output).toContain('"title": "Example Domain"')
    expect(navigate).toHaveBeenCalledWith("agent-1", "https://example.com/")
    expect(captureScreenshot).toHaveBeenCalledTimes(1)
    expect(inserts.filter((entry) => entry.table === "browser_event")).toHaveLength(2)
    expect(inserts.filter((entry) => entry.table === "browser_screenshot")).toHaveLength(1)
  })

  it("returns explicit browser connection failures and persists an error event", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "test-key" })

    const navigate = vi
      .fn()
      .mockRejectedValue(
        new BrowserActionError("BROWSER_CONNECTION_FAILED", "WebSocket connection timeout"),
      )
    const observationService = {
      navigate,
      captureScreenshot: vi.fn(),
    }
    const { db, inserts } = makeDbRecorder()

    const registry = await backend.createAgentRegistry(
      {},
      {
        agentId: "agent-1",
        allowedTools: ["playwright_navigate"],
        deniedTools: [],
        browser: {
          db: db as never,
          observationService: observationService as never,
        },
      },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient
    let callCount = 0
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockAnthropicStream({
          textContent: "Trying the browser.",
          toolUseBlocks: [
            {
              id: "toolu_browser_2",
              name: "playwright_navigate",
              input: { url: "https://example.com" },
            },
          ],
          stopReason: "tool_use",
        })
      }
      return createMockAnthropicStream({
        textContent: "The browser connection failed.",
        stopReason: "end_turn",
      })
    })

    const handle = await backend.executeTask(makeTask(), registry)
    const events = await collectEvents(handle)

    const toolResult = events.find(
      (event): event is Extract<OutputEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    )
    expect(toolResult).toBeDefined()
    expect(toolResult?.isError).toBe(true)
    expect(toolResult?.output).toContain("BROWSER_CONNECTION_FAILED")
    expect(inserts.filter((entry) => entry.table === "browser_screenshot")).toHaveLength(0)
    expect(inserts.filter((entry) => entry.table === "browser_event")).toHaveLength(1)
    expect(inserts[0]?.values["message"]).toBe(
      "[BROWSER_CONNECTION_FAILED] WebSocket connection timeout",
    )
  })
})
