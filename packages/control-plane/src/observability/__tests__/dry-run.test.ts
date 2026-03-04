import type { TokenUsage } from "@cortex/shared/backends"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DryRunError, executeDryRun, stubToolRegistry } from "../dry-run.js"

// ---------------------------------------------------------------------------
// Mock: HttpLlmBackend + tool-executor
// ---------------------------------------------------------------------------

// We need to mock the HttpLlmBackend to avoid real API calls,
// and loadConversationHistory to avoid real DB queries.

const mockBackendStop = vi.fn().mockResolvedValue(undefined)
const mockBackendStart = vi.fn().mockResolvedValue(undefined)

const mockToolRegistry = {
  get: vi.fn().mockReturnValue({ name: "echo", description: "test", inputSchema: {} }),
  resolve: vi.fn().mockReturnValue([]),
  register: vi.fn(),
  execute: vi.fn().mockResolvedValue({ output: "ok", isError: false }),
}

const mockCreateAgentRegistry = vi.fn().mockResolvedValue(mockToolRegistry)

const mockEvents: Array<{
  type: string
  timestamp: string
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  tokenUsage?: TokenUsage
}> = []

const mockHandle = {
  taskId: "dry-run-test",
  events: async function* () {
    for (const e of mockEvents) {
      yield e
    }
  },
  result: vi.fn().mockResolvedValue({ status: "completed" }),
  cancel: vi.fn(),
}

const mockExecuteTask = vi.fn().mockResolvedValue(mockHandle)

vi.mock("../../backends/http-llm.js", () => ({
  HttpLlmBackend: vi.fn().mockImplementation(() => ({
    start: mockBackendStart,
    stop: mockBackendStop,
    createAgentRegistry: mockCreateAgentRegistry,
    executeTask: mockExecuteTask,
  })),
}))

vi.mock("../../channels/message-dispatch.js", () => ({
  loadConversationHistory: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-dry-001",
    name: "Test Agent",
    slug: "test-agent",
    role: "assistant",
    description: "A test agent",
    model_config: {},
    skill_config: {},
    resource_limits: {},
    channel_permissions: {},
    config: {},
    status: "ACTIVE",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function selectChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
  const terminal = { executeTakeFirst }
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, ...terminal })
  const selectAll = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  return { selectAll, select }
}

function mockDb(
  opts: { agent?: Record<string, unknown> | null; session?: { id: string } | null } = {},
) {
  const { agent = makeAgent(), session = null } = opts

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") return selectChain(agent ? [agent] : [])
      if (table === "session") return selectChain(session ? [session] : [])
      if (table === "session_message") return selectChain([])
      return selectChain([])
    }),
  } as unknown as import("kysely").Kysely<import("../../db/types.js").Database>
}

// ---------------------------------------------------------------------------
// Tests: stubToolRegistry
// ---------------------------------------------------------------------------

describe("stubToolRegistry", () => {
  it("replaces execute with a dry-run stub", async () => {
    const { ToolRegistry } = await import("../../backends/tool-executor.js")
    const registry = new ToolRegistry()
    registry.register({
      name: "test_tool",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} },
      execute: () => Promise.resolve("real output"),
    })

    stubToolRegistry(registry)

    const result = await registry.execute("test_tool", { key: "value" })
    expect(result.output).toContain("[DRY RUN]")
    expect(result.output).toContain("test_tool")
    expect(result.output).toContain('"key":"value"')
    expect(result.isError).toBe(false)
  })

  it("preserves unknown-tool error behavior", async () => {
    const { ToolRegistry } = await import("../../backends/tool-executor.js")
    const registry = new ToolRegistry()
    stubToolRegistry(registry)

    const result = await registry.execute("nonexistent", {})
    expect(result.output).toContain("Unknown tool")
    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: executeDryRun
// ---------------------------------------------------------------------------

describe("executeDryRun", () => {
  beforeEach(() => {
    mockEvents.length = 0
    vi.clearAllMocks()
  })

  it("returns planned actions and agent response for a text-only response", async () => {
    mockEvents.push(
      { type: "text", timestamp: new Date().toISOString(), content: "Hello from dry run" },
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    )

    const db = mockDb()
    const result = await executeDryRun("agent-dry-001", { message: "Hello" }, { db })

    expect(result.plannedActions).toEqual([])
    expect(result.agentResponse).toBe("Hello from dry run")
    expect(result.tokensUsed).toEqual({ in: 100, out: 50 })
    expect(result.estimatedCostUsd).toBeGreaterThan(0)
  })

  it("collects tool calls as planned actions", async () => {
    mockEvents.push(
      { type: "text", timestamp: new Date().toISOString(), content: "Let me search." },
      {
        type: "tool_use",
        timestamp: new Date().toISOString(),
        toolName: "web_search",
        toolInput: { query: "test" },
      },
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 200,
          outputTokens: 80,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    )

    const db = mockDb()
    const result = await executeDryRun("agent-dry-001", { message: "Search for test" }, { db })

    expect(result.plannedActions).toHaveLength(1)
    expect(result.plannedActions[0]).toEqual({
      type: "tool_call",
      toolRef: "web_search",
      input: { query: "test" },
    })
    expect(result.agentResponse).toBe("Let me search.")
  })

  it("throws DryRunError when agent not found", async () => {
    const db = mockDb({ agent: null })

    await expect(executeDryRun("nonexistent", { message: "Hello" }, { db })).rejects.toThrow(
      DryRunError,
    )

    try {
      await executeDryRun("nonexistent", { message: "Hello" }, { db })
    } catch (err) {
      expect(err).toBeInstanceOf(DryRunError)
      expect((err as DryRunError).code).toBe("not_found")
    }
  })

  it("throws DryRunError when agent is not ACTIVE", async () => {
    const db = mockDb({ agent: makeAgent({ status: "DISABLED" }) })

    await expect(executeDryRun("agent-dry-001", { message: "Hello" }, { db })).rejects.toThrow(
      DryRunError,
    )

    try {
      await executeDryRun("agent-dry-001", { message: "Hello" }, { db })
    } catch (err) {
      expect(err).toBeInstanceOf(DryRunError)
      expect((err as DryRunError).code).toBe("conflict")
    }
  })

  it("does not write to any database tables (no session_message, no job, no checkpoint)", async () => {
    mockEvents.push(
      { type: "text", timestamp: new Date().toISOString(), content: "No side effects" },
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    )

    const db = mockDb()
    await executeDryRun("agent-dry-001", { message: "Hello" }, { db })

    // Verify no insertInto or updateTable calls
    expect(db.selectFrom).toHaveBeenCalled() // reads are expected
    expect((db as unknown as Record<string, unknown>).insertInto).toBeUndefined()
    expect((db as unknown as Record<string, unknown>).updateTable).toBeUndefined()
  })

  it("stops the backend after execution", async () => {
    mockEvents.push(
      { type: "text", timestamp: new Date().toISOString(), content: "Done" },
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    )

    const db = mockDb()
    await executeDryRun("agent-dry-001", { message: "Hello" }, { db })

    expect(mockBackendStop).toHaveBeenCalled()
  })

  it("passes maxTurns from input", async () => {
    mockEvents.push(
      { type: "text", timestamp: new Date().toISOString(), content: "Done" },
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    )

    const db = mockDb()
    await executeDryRun("agent-dry-001", { message: "Hello", maxTurns: 3 }, { db })

    // Verify executeTask was called and the task constraints reflect maxTurns
    expect(mockExecuteTask).toHaveBeenCalled()
    const calls = mockExecuteTask.mock.calls
    const taskArg = calls[0]![0] as { constraints: { maxTurns: number } }
    expect(taskArg.constraints.maxTurns).toBe(3)
  })
})
