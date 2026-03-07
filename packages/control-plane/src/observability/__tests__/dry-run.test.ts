import { describe, expect, it, vi } from "vitest"

import { ToolRegistry } from "../../backends/tool-executor.js"
import {
  type ConversationTurn,
  estimateCost,
  loadConversationContext,
  type PlannedAction,
  stubTools,
} from "../dry-run.js"

// ---------------------------------------------------------------------------
// stubTools
// ---------------------------------------------------------------------------

describe("stubTools", () => {
  function createRegistry(): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register({
      name: "search",
      description: "Search the web",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      execute: vi.fn().mockResolvedValue("real search result"),
    })
    registry.register({
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: vi.fn().mockResolvedValue("file written"),
    })
    return registry
  }

  it("returns tool definitions with stubbed execute()", () => {
    const registry = createRegistry()
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search", "write_file"], [], actions)

    expect(stubbed).toHaveLength(2)
    expect(stubbed[0]!.name).toBe("search")
    expect(stubbed[1]!.name).toBe("write_file")
  })

  it("stub execute() records planned action and returns dry-run message", async () => {
    const registry = createRegistry()
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search"], [], actions)
    const result = await stubbed[0]!.execute({ query: "hello" })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toEqual({
      type: "tool_call",
      toolRef: "search",
      input: { query: "hello" },
    })
    expect(result).toBe('[DRY RUN] Tool search would be called with: {"query":"hello"}')
  })

  it("does not call the original execute()", async () => {
    const registry = createRegistry()
    const originalExecute = registry.get("search")!.execute as ReturnType<typeof vi.fn>
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search"], [], actions)
    await stubbed[0]!.execute({ query: "test" })

    expect(originalExecute).not.toHaveBeenCalled()
  })

  it("preserves tool metadata (description, inputSchema)", () => {
    const registry = createRegistry()
    const original = registry.get("search")!
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search"], [], actions)
    const stub = stubbed[0]!

    expect(stub.description).toBe(original.description)
    expect(stub.inputSchema).toEqual(original.inputSchema)
  })

  it("respects allowedTools/deniedTools filters", () => {
    const registry = createRegistry()
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search", "write_file"], ["write_file"], actions)

    expect(stubbed).toHaveLength(1)
    expect(stubbed[0]!.name).toBe("search")
  })

  it("returns empty array when no tools match", () => {
    const registry = createRegistry()
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["nonexistent"], [], actions)

    expect(stubbed).toHaveLength(0)
  })

  it("accumulates multiple planned actions across calls", async () => {
    const registry = createRegistry()
    const actions: PlannedAction[] = []

    const stubbed = stubTools(registry, ["search", "write_file"], [], actions)
    await stubbed[0]!.execute({ query: "first" })
    await stubbed[1]!.execute({ path: "/tmp/file.txt" })

    expect(actions).toHaveLength(2)
    expect(actions[0]!.toolRef).toBe("search")
    expect(actions[1]!.toolRef).toBe("write_file")
  })
})

// ---------------------------------------------------------------------------
// loadConversationContext
// ---------------------------------------------------------------------------

describe("loadConversationContext", () => {
  it("returns empty array when no sessionId is provided", async () => {
    const db = {} as never // not called
    const result = await loadConversationContext(db)
    expect(result).toEqual([])
  })

  it("returns empty array when sessionId is undefined", async () => {
    const db = {} as never
    const result = await loadConversationContext(db, undefined)
    expect(result).toEqual([])
  })

  it("queries session_message table and maps rows", async () => {
    const mockRows: Array<{ role: string; content: string }> = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]

    const execute = vi.fn().mockResolvedValue(mockRows)
    const orderBy = vi.fn().mockReturnValue({ execute })
    const where = vi.fn().mockReturnValue({ orderBy })
    const select = vi.fn().mockReturnValue({ where })
    const selectFrom = vi.fn().mockReturnValue({ select })
    const db = { selectFrom } as never

    const result = await loadConversationContext(db, "session-123")

    expect(selectFrom).toHaveBeenCalledWith("session_message")
    expect(select).toHaveBeenCalledWith(["role", "content"])
    expect(where).toHaveBeenCalledWith("session_id", "=", "session-123")
    expect(orderBy).toHaveBeenCalledWith("created_at", "asc")

    const expected: ConversationTurn[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]
    expect(result).toEqual(expected)
  })

  it("returns empty array when session has no messages", async () => {
    const execute = vi.fn().mockResolvedValue([])
    const orderBy = vi.fn().mockReturnValue({ execute })
    const where = vi.fn().mockReturnValue({ orderBy })
    const select = vi.fn().mockReturnValue({ where })
    const selectFrom = vi.fn().mockReturnValue({ select })
    const db = { selectFrom } as never

    const result = await loadConversationContext(db, "empty-session")

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  it("returns 0 for zero token usage", () => {
    const cost = estimateCost({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    expect(cost).toBe(0)
  })

  it("calculates cost based on input/output tokens", () => {
    const cost = estimateCost({
      inputTokens: 1000,
      outputTokens: 1000,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    // 1000/1000 * 0.003 + 1000/1000 * 0.015 = 0.003 + 0.015 = 0.018
    expect(cost).toBe(0.018)
  })

  it("handles large token counts", () => {
    const cost = estimateCost({
      inputTokens: 100_000,
      outputTokens: 10_000,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    // 100 * 0.003 + 10 * 0.015 = 0.3 + 0.15 = 0.45
    expect(cost).toBe(0.45)
  })

  it("rounds to 6 decimal places", () => {
    const cost = estimateCost({
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    // 0.001 * 0.003 + 0.001 * 0.015 = 0.000003 + 0.000015 = 0.000018
    expect(cost).toBe(0.000018)
  })

  it("ignores the costUsd field from input (recalculates independently)", () => {
    const cost = estimateCost({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 999,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
    expect(cost).toBe(0)
  })
})
