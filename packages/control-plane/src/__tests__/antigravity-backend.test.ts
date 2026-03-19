import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"
import type { AssistantMessage } from "@mariozechner/pi-ai"
import { AssistantMessageEventStream } from "@mariozechner/pi-ai"
import { describe, expect, it } from "vitest"

import { AntigravityHandle, resolveAntigravityModel } from "../backends/antigravity-backend.js"
import { createDefaultToolRegistry } from "../backends/tool-executor.js"

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-ag-001",
    jobId: "job-ag-001",
    agentId: "agent-ag-001",
    instruction: { prompt: "Say hello", goalType: "research" },
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
      model: "claude-sonnet-4-5",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 1,
      networkAccess: false,
      shellAccess: false,
      llmCredential: {
        provider: "google-antigravity",
        token: "gcp-oauth-token",
        credentialId: "cred-gcp-test",
        accountId: "my-gcp-project",
      },
    },
    ...overrides,
  }
}

function mockStream(
  text: string,
  stopReason: "stop" | "toolUse" = "stop",
  inputTokens = 10,
  outputTokens = 20,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()
  const content: AssistantMessage["content"] = []
  if (text) content.push({ type: "text", text })
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments })
    }
  }
  const msg: AssistantMessage = {
    role: "assistant",
    content,
    api: "google-gemini-cli",
    provider: "google-antigravity",
    model: "claude-sonnet-4-5",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason,
    timestamp: Date.now(),
  }
  const partial = { ...msg, content: [] } as AssistantMessage
  queueMicrotask(() => {
    stream.push({ type: "start", partial })
    if (text) {
      stream.push({ type: "text_start", contentIndex: 0, partial })
      for (let ci = 0; ci < text.length; ci += 10) {
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: text.slice(ci, ci + 10),
          partial,
        })
      }
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial })
    }
    if (toolCalls) {
      for (let ti = 0; ti < toolCalls.length; ti++) {
        const tc = toolCalls[ti]
        stream.push({ type: "toolcall_start", contentIndex: ti + 1, partial })
        stream.push({
          type: "toolcall_end",
          contentIndex: ti + 1,
          toolCall: { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments },
          partial,
        })
      }
    }
    stream.push(
      stopReason === "toolUse"
        ? { type: "done", reason: "toolUse", message: msg }
        : { type: "done", reason: "stop", message: msg },
    )
  })
  return stream
}

async function collectEvents(handle: {
  events(): AsyncIterable<OutputEvent>
}): Promise<OutputEvent[]> {
  const events: OutputEvent[] = []
  for await (const e of handle.events()) events.push(e)
  return events
}

describe("resolveAntigravityModel", () => {
  it("resolves a known model ID", () => {
    const m = resolveAntigravityModel("claude-sonnet-4-5")
    expect(m.id).toBe("claude-sonnet-4-5")
    expect(m.api).toBe("google-gemini-cli")
  })

  it("strips date suffix from model ID", () => {
    const m = resolveAntigravityModel("claude-sonnet-4-5-20250929")
    expect(m.id).toBe("claude-sonnet-4-5")
  })

  it("overrides baseUrl when provided", () => {
    const m = resolveAntigravityModel("claude-sonnet-4-5", "https://custom.example.com")
    expect(m.baseUrl).toBe("https://custom.example.com")
  })
})

describe("AntigravityHandle — text streaming", () => {
  it("maps text_delta events to OutputTextEvent and accumulates usage", async () => {
    const handle = new AntigravityHandle(
      makeTask(),
      "claude-sonnet-4-5",
      Date.now(),
      createDefaultToolRegistry(),
      "https://cloudcode-pa.googleapis.com",
      {},
    )
    handle.streamFactory = () => mockStream("Hello from Antigravity!", "stop", 50, 30)
    const events = await collectEvents(handle)

    const allText = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { content: string }).content)
      .join("")
    expect(allText).toBe("Hello from Antigravity!")

    const usageEvent = events.find((e) => e.type === "usage")
    expect(usageEvent).toMatchObject({
      tokenUsage: { inputTokens: 50, outputTokens: 30 },
    })

    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Hello from Antigravity!")
  })
})

describe("AntigravityHandle — tool calls", () => {
  it("executes echo tool and feeds results back", async () => {
    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        maxTurns: 5,
        allowedTools: ["echo"],
      },
    })
    const handle = new AntigravityHandle(
      task,
      "claude-sonnet-4-5",
      Date.now(),
      createDefaultToolRegistry(),
      "https://cloudcode-pa.googleapis.com",
      {},
    )
    let callCount = 0
    handle.streamFactory = () => {
      callCount++
      if (callCount === 1) {
        return mockStream("Let me echo.", "toolUse", 50, 30, [
          { id: "tc_001", name: "echo", arguments: { text: "hello" } },
        ])
      }
      return mockStream("Done", "stop", 80, 15)
    }
    const events = await collectEvents(handle)
    expect(events.filter((e) => e.type === "tool_use")).toHaveLength(1)
    const tr = events.find((e) => e.type === "tool_result")
    expect(tr).toMatchObject({ toolName: "echo", output: "hello", isError: false })
    expect((await handle.result()).status).toBe("completed")
    expect(callCount).toBe(2)
  })
})

describe("AntigravityHandle — cancellation", () => {
  it("returns cancelled result", async () => {
    const handle = new AntigravityHandle(
      makeTask(),
      "claude-sonnet-4-5",
      Date.now(),
      createDefaultToolRegistry(),
      "https://cloudcode-pa.googleapis.com",
      {},
    )
    await handle.cancel("Test cancellation")
    const result = await handle.result()
    expect(result.status).toBe("cancelled")
    expect(result.summary).toContain("Test cancellation")
  })
})

describe("AntigravityHandle — usage mapping", () => {
  it("maps pi-ai Usage to Cortex TokenUsage with costUsd", async () => {
    const handle = new AntigravityHandle(
      makeTask(),
      "claude-sonnet-4-5",
      Date.now(),
      createDefaultToolRegistry(),
      "https://cloudcode-pa.googleapis.com",
      {},
    )
    handle.streamFactory = () => mockStream("test", "stop", 100, 50)
    const events = await collectEvents(handle)
    const usageEvent = events.find((e) => e.type === "usage")
    expect(usageEvent).toMatchObject({
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.003,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })
  })
})
