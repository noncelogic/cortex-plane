import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { McpClientPool } from "../mcp/tool-bridge.js"
import { McpToolRouter, type McpToolRouterDeps } from "../mcp/tool-router.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-111"

/** Minimal mock of a McpClientPool. Returns the pool and its mock fn. */
function mockPool(): McpClientPool & { _callTool: ReturnType<typeof vi.fn> } {
  const callTool = vi.fn().mockResolvedValue("mcp-result")
  return { callTool, _callTool: callTool }
}

/** Build a fake joined row as returned by the Kysely queries in McpToolRouter. */
function makeRow(
  overrides: {
    toolName?: string
    serverSlug?: string
    serverId?: string
    serverCreatedAt?: Date
    agentScope?: string[]
    serverStatus?: string
    toolStatus?: string
    description?: string | null
    inputSchema?: Record<string, unknown>
  } = {},
) {
  const {
    toolName = "read_file",
    serverSlug = "server-a",
    serverId = "aaaaaaaa-0000-0000-0000-000000000001",
    serverCreatedAt = new Date("2025-01-01T00:00:00Z"),
    agentScope = [],
    serverStatus = "ACTIVE",
    toolStatus = "available",
    description = "A tool",
    inputSchema = { type: "object", properties: {} },
  } = overrides

  return {
    // mcp_server_tool columns
    id: `tool-${serverId}-${toolName}`,
    mcp_server_id: serverId,
    name: toolName,
    qualified_name: `mcp:${serverSlug}:${toolName}`,
    description,
    input_schema: inputSchema,
    annotations: null,
    status: toolStatus,
    created_at: serverCreatedAt,
    updated_at: serverCreatedAt,
    // mcp_server columns (prefixed)
    server_id: serverId,
    server_name: `Server ${serverSlug}`,
    server_slug: serverSlug,
    server_transport: "streamable-http",
    server_connection: { url: "https://example.com/mcp" },
    server_agent_scope: agentScope,
    server_status: serverStatus,
    server_description: null,
    server_protocol_version: null,
    server_server_info: null,
    server_capabilities: null,
    server_health_probe_interval_ms: 30000,
    server_last_healthy_at: null,
    server_error_message: null,
    server_created_at: serverCreatedAt,
    server_updated_at: serverCreatedAt,
  }
}

/**
 * Create a mock Kysely db that returns specified rows for any query.
 *
 * The mock builds a fluent chain: selectFrom → innerJoin → selectAll → select
 * → where → orderBy → execute / executeTakeFirst
 */
function mockDb(rows: ReturnType<typeof makeRow>[]) {
  const execute = vi.fn().mockResolvedValue(rows)
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? undefined)

  const orderBy = vi.fn().mockReturnValue({ execute, executeTakeFirst })
  const where = vi.fn()

  // Each .where() call chains to another .where() or terminal
  where.mockReturnValue({
    where,
    orderBy,
    execute,
    executeTakeFirst,
  })

  const selectFn = vi.fn().mockReturnValue({
    where,
    orderBy,
    execute,
    executeTakeFirst,
  })
  const selectAll = vi.fn().mockReturnValue({
    select: selectFn,
    where,
    orderBy,
    execute,
    executeTakeFirst,
  })
  const innerJoin = vi.fn().mockReturnValue({
    selectAll,
    select: selectFn,
    where,
    orderBy,
    execute,
    executeTakeFirst,
  })
  const selectFrom = vi.fn().mockReturnValue({
    innerJoin,
    selectAll,
    select: selectFn,
    where,
    orderBy,
    execute,
    executeTakeFirst,
  })

  return { selectFrom, _execute: execute, _where: where } as unknown as McpToolRouterDeps["db"]
}

function makeDeps(rows: ReturnType<typeof makeRow>[]): McpToolRouterDeps & { pool: McpClientPool } {
  const pool = mockPool()
  return { db: mockDb(rows), clientPool: pool, pool }
}

// ---------------------------------------------------------------------------
// Clock setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════
// resolve — qualified names
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolve — qualified names", () => {
  it("resolves a qualified name to a ToolDefinition", async () => {
    const row = makeRow({ toolName: "read_file", serverSlug: "srv" })
    const deps = makeDeps([row])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("mcp:srv:read_file", AGENT_ID)

    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:srv:read_file")
  })

  it("returns null when no match for qualified name", async () => {
    const deps = makeDeps([])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("mcp:missing:tool", AGENT_ID)

    expect(result).toBeNull()
  })

  it("delegates execution to the client pool", async () => {
    const row = makeRow({ toolName: "search", serverSlug: "search-srv" })
    const deps = makeDeps([row])
    const router = new McpToolRouter(deps)

    const def = await router.resolve("mcp:search-srv:search", AGENT_ID)
    const output = await def!.execute({ query: "test" })

    expect(deps.pool._callTool).toHaveBeenCalledWith("search-srv", "search", { query: "test" })
    expect(output).toBe("mcp-result")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// resolve — unqualified names (single match)
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolve — unqualified names", () => {
  it("resolves when exactly one server provides the tool", async () => {
    const row = makeRow({ toolName: "read_file", serverSlug: "srv-a" })
    const deps = makeDeps([row])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("read_file", AGENT_ID)

    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:srv-a:read_file")
  })

  it("returns null when no server provides the tool", async () => {
    const deps = makeDeps([])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("nonexistent", AGENT_ID)

    expect(result).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// resolve — conflict resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolve — conflict resolution", () => {
  it("prefers server with agent in scope", async () => {
    const rowA = makeRow({
      toolName: "search",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: new Date("2025-01-01"),
    })
    const rowB = makeRow({
      toolName: "search",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [AGENT_ID],
      serverCreatedAt: new Date("2025-01-02"),
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("search", AGENT_ID)

    expect(result!.name).toBe("mcp:srv-b:search")
  })

  it("uses agent preference when multiple scope matches", async () => {
    const rowA = makeRow({
      toolName: "deploy",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [AGENT_ID],
      serverCreatedAt: new Date("2025-01-01"),
    })
    const rowB = makeRow({
      toolName: "deploy",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [AGENT_ID],
      serverCreatedAt: new Date("2025-01-01"),
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    const agentConfig = {
      mcp_preferences: { server_priority: ["srv-b", "srv-a"] },
    }

    const result = await router.resolve("deploy", AGENT_ID, agentConfig)

    expect(result!.name).toBe("mcp:srv-b:deploy")
  })

  it("falls back to first registered when no scope or preference match", async () => {
    const rowA = makeRow({
      toolName: "query",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: new Date("2025-01-01"),
    })
    const rowB = makeRow({
      toolName: "query",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: new Date("2025-06-01"),
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("query", AGENT_ID)

    expect(result!.name).toBe("mcp:srv-a:query")
  })

  it("throws ambiguity error when timestamps match", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "run",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "run",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    await expect(router.resolve("run", AGENT_ID)).rejects.toThrow(/Ambiguous tool name "run"/)
  })

  it("ambiguity error includes qualified name suggestions", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "run",
      serverSlug: "alpha",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "run",
      serverSlug: "beta",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    await expect(router.resolve("run", AGENT_ID)).rejects.toThrow(/mcp:alpha:run.*mcp:beta:run/)
  })

  it("uses agent preference to resolve conflicts without scope", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "exec",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "exec",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    const agentConfig = {
      mcp_preferences: { server_priority: ["srv-b"] },
    }

    const result = await router.resolve("exec", AGENT_ID, agentConfig)

    expect(result!.name).toBe("mcp:srv-b:exec")
  })

  it("ignores server_priority entries that are not candidates", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "op",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "op",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    // Priority lists a slug not among the candidates
    const agentConfig = {
      mcp_preferences: { server_priority: ["srv-nonexistent"] },
    }

    // Should fall through to timestamps → ambiguity error
    await expect(router.resolve("op", AGENT_ID, agentConfig)).rejects.toThrow(
      /Ambiguous tool name "op"/,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// resolveAll
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolveAll", () => {
  it("returns all active tools when allowed list is empty", async () => {
    const rows = [
      makeRow({ toolName: "tool_a", serverSlug: "srv" }),
      makeRow({ toolName: "tool_b", serverSlug: "srv" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    // Empty allowedTools = no filter (all MCP tools returned)
    // NOTE: Per the resolveAll implementation, if allowedTools.length > 0
    // tools must match. If length === 0, all tools pass the allow filter.
    const result = await router.resolveAll(AGENT_ID, [], [])

    expect(result).toHaveLength(2)
  })

  it("filters by allowedTools exact match", async () => {
    const rows = [
      makeRow({ toolName: "tool_a", serverSlug: "srv" }),
      makeRow({ toolName: "tool_b", serverSlug: "srv" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:srv:tool_a"], [])

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("mcp:srv:tool_a")
  })

  it("filters by deniedTools — denied takes precedence", async () => {
    const rows = [
      makeRow({ toolName: "safe", serverSlug: "srv" }),
      makeRow({ toolName: "dangerous", serverSlug: "srv" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, [], ["mcp:srv:dangerous"])

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("mcp:srv:safe")
  })

  it("denied overrides allowed", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:srv:tool_a"], ["mcp:srv:tool_a"])

    expect(result).toHaveLength(0)
  })

  it("filters by agent_scope — excludes tools from scoped servers", async () => {
    const rows = [
      makeRow({ toolName: "tool_a", serverSlug: "srv-a", agentScope: [AGENT_ID] }),
      makeRow({
        toolName: "tool_b",
        serverSlug: "srv-b",
        agentScope: ["other-agent"],
      }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, [], [])

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("mcp:srv-a:tool_a")
  })

  it("includes tools from servers with empty agent_scope (all agents)", async () => {
    const rows = [
      makeRow({ toolName: "tool_a", serverSlug: "srv-a", agentScope: [] }),
      makeRow({ toolName: "tool_b", serverSlug: "srv-b", agentScope: [AGENT_ID] }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, [], [])

    expect(result).toHaveLength(2)
  })

  it("returns empty when no tools match", async () => {
    const deps = makeDeps([])
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, [], [])

    expect(result).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// resolveAll — glob patterns
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolveAll — glob patterns", () => {
  it("matches tools with wildcard in tool name", async () => {
    const rows = [
      makeRow({ toolName: "read_file", serverSlug: "fs" }),
      makeRow({ toolName: "write_file", serverSlug: "fs" }),
      makeRow({ toolName: "delete_file", serverSlug: "fs" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:fs:*_file"], [])

    expect(result).toHaveLength(3)
  })

  it("matches tools with wildcard in server slug", async () => {
    const rows = [
      makeRow({ toolName: "search", serverSlug: "google-search" }),
      makeRow({ toolName: "search", serverSlug: "bing-search" }),
      makeRow({ toolName: "fetch", serverSlug: "http-client" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:*-search:*"], [])

    expect(result).toHaveLength(2)
  })

  it("supports full wildcard pattern", async () => {
    const rows = [
      makeRow({ toolName: "tool_a", serverSlug: "srv-1" }),
      makeRow({ toolName: "tool_b", serverSlug: "srv-2" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:*:*"], [])

    expect(result).toHaveLength(2)
  })

  it("denies with glob pattern", async () => {
    const rows = [
      makeRow({ toolName: "read_file", serverSlug: "fs" }),
      makeRow({ toolName: "write_file", serverSlug: "fs" }),
      makeRow({ toolName: "search", serverSlug: "web" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, [], ["mcp:fs:*"])

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("mcp:web:search")
  })

  it("glob deny takes precedence over glob allow", async () => {
    const rows = [
      makeRow({ toolName: "read_file", serverSlug: "fs" }),
      makeRow({ toolName: "write_file", serverSlug: "fs" }),
    ]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:fs:*"], ["mcp:fs:write_file"])

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("mcp:fs:read_file")
  })

  it("non-matching glob returns empty", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const result = await router.resolveAll(AGENT_ID, ["mcp:other:*"], [])

    expect(result).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Caching
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter — caching", () => {
  it("caches resolveAll results within TTL", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    await router.resolveAll(AGENT_ID, [], [])
    await router.resolveAll(AGENT_ID, [], [])

    // DB should only be queried once
    expect(db.selectFrom).toHaveBeenCalledTimes(1)
  })

  it("re-queries after TTL expires", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    await router.resolveAll(AGENT_ID, [], [])

    // Advance time past the 60s TTL
    vi.advanceTimersByTime(61_000)

    await router.resolveAll(AGENT_ID, [], [])

    expect(db.selectFrom).toHaveBeenCalledTimes(2)
  })

  it("uses separate cache entries for different args", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const router = new McpToolRouter(deps)

    const r1 = await router.resolveAll(AGENT_ID, [], [])
    const r2 = await router.resolveAll(AGENT_ID, ["mcp:srv:tool_a"], [])

    // Different cache keys → different filtered results
    // r1 has no allow filter so returns all; r2 filters to just tool_a
    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)

    // After invalidation, both are re-computed
    router.invalidateCache()
    const r3 = await router.resolveAll(AGENT_ID, ["mcp:nonexistent:x"], [])
    expect(r3).toHaveLength(0)
  })

  it("invalidateCache clears all cached entries", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    await router.resolveAll(AGENT_ID, [], [])

    router.invalidateCache()

    await router.resolveAll(AGENT_ID, [], [])

    expect(db.selectFrom).toHaveBeenCalledTimes(2)
  })

  it("caches resolve (qualified) results", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    await router.resolve("mcp:srv:tool_a", AGENT_ID)
    await router.resolve("mcp:srv:tool_a", AGENT_ID)

    expect(db.selectFrom).toHaveBeenCalledTimes(1)
  })

  it("caches resolve (unqualified) results", async () => {
    const rows = [makeRow({ toolName: "tool_a", serverSlug: "srv" })]
    const deps = makeDeps(rows)
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    await router.resolve("tool_a", AGENT_ID)
    await router.resolve("tool_a", AGENT_ID)

    expect(db.selectFrom).toHaveBeenCalledTimes(1)
  })

  it("caches null results for missing tools", async () => {
    const deps = makeDeps([])
    const db = deps.db as unknown as { selectFrom: ReturnType<typeof vi.fn> }
    const router = new McpToolRouter(deps)

    const r1 = await router.resolve("mcp:missing:tool", AGENT_ID)
    const r2 = await router.resolve("mcp:missing:tool", AGENT_ID)

    expect(r1).toBeNull()
    expect(r2).toBeNull()
    expect(db.selectFrom).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// getServerPriority edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("McpToolRouter.resolve — server priority edge cases", () => {
  it("handles missing mcp_preferences in agentConfig", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "op",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "op",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    // agentConfig without mcp_preferences → falls through
    await expect(router.resolve("op", AGENT_ID, { other_key: true })).rejects.toThrow(/Ambiguous/)
  })

  it("handles non-array server_priority gracefully", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rowA = makeRow({
      toolName: "op",
      serverSlug: "srv-a",
      serverId: "id-a",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const rowB = makeRow({
      toolName: "op",
      serverSlug: "srv-b",
      serverId: "id-b",
      agentScope: [],
      serverCreatedAt: sameTime,
    })
    const deps = makeDeps([rowA, rowB])
    const router = new McpToolRouter(deps)

    const agentConfig = {
      mcp_preferences: { server_priority: "not-an-array" },
    }

    await expect(router.resolve("op", AGENT_ID, agentConfig)).rejects.toThrow(/Ambiguous/)
  })

  it("handles undefined agentConfig", async () => {
    const row = makeRow({ toolName: "solo", serverSlug: "srv" })
    const deps = makeDeps([row])
    const router = new McpToolRouter(deps)

    const result = await router.resolve("solo", AGENT_ID, undefined)

    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:srv:solo")
  })
})
