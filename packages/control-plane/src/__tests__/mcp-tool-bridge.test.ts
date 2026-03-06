import { describe, expect, it, vi } from "vitest"

import type { McpServer, McpServerTool } from "../db/types.js"
import type { McpClientPool } from "../mcp/tool-bridge.js"
import { createMcpToolDefinition, parseQualifiedName, qualifiedName } from "../mcp/tool-bridge.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Test Server",
    slug: "test-server",
    transport: "streamable-http",
    connection: { url: "https://example.com/mcp" },
    agent_scope: [],
    description: "A test MCP server",
    status: "ACTIVE",
    protocol_version: null,
    server_info: null,
    capabilities: null,
    health_probe_interval_ms: 30000,
    last_healthy_at: null,
    error_message: null,
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-01"),
    ...overrides,
  } as McpServer
}

function makeTool(overrides: Partial<McpServerTool> = {}): McpServerTool {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    mcp_server_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "read_file",
    qualified_name: "mcp:test-server:read_file",
    description: "Read a file from the filesystem",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: null,
    status: "available",
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-01"),
    ...overrides,
  } as McpServerTool
}

function mockPool(): McpClientPool {
  return {
    callTool: vi.fn().mockResolvedValue({ output: "tool-result", isError: false }),
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue({}),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// qualifiedName
// ═══════════════════════════════════════════════════════════════════════════

describe("qualifiedName", () => {
  it("builds mcp:<slug>:<name> format", () => {
    expect(qualifiedName("my-server", "read_file")).toBe("mcp:my-server:read_file")
  })

  it("handles slugs with hyphens", () => {
    expect(qualifiedName("my-cool-server", "do_stuff")).toBe("mcp:my-cool-server:do_stuff")
  })

  it("handles underscored tool names", () => {
    expect(qualifiedName("s", "my_long_tool_name")).toBe("mcp:s:my_long_tool_name")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// parseQualifiedName
// ═══════════════════════════════════════════════════════════════════════════

describe("parseQualifiedName", () => {
  it("parses a valid qualified name", () => {
    const result = parseQualifiedName("mcp:my-server:read_file")
    expect(result).toEqual({ serverSlug: "my-server", toolName: "read_file" })
  })

  it("returns null for non-mcp prefixed names", () => {
    expect(parseQualifiedName("echo")).toBeNull()
    expect(parseQualifiedName("web_search")).toBeNull()
    expect(parseQualifiedName("custom_tool")).toBeNull()
  })

  it("returns null for names with too few parts", () => {
    expect(parseQualifiedName("mcp:only-one")).toBeNull()
  })

  it("returns null for names with too many parts", () => {
    expect(parseQualifiedName("mcp:server:tool:extra")).toBeNull()
  })

  it("returns null for empty slug or tool name", () => {
    expect(parseQualifiedName("mcp::read_file")).toBeNull()
    expect(parseQualifiedName("mcp:server:")).toBeNull()
  })

  it("returns null for prefix-only", () => {
    expect(parseQualifiedName("mcp:")).toBeNull()
  })

  it("is case-sensitive", () => {
    expect(parseQualifiedName("MCP:server:tool")).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// createMcpToolDefinition
// ═══════════════════════════════════════════════════════════════════════════

describe("createMcpToolDefinition", () => {
  it("creates a ToolDefinition with qualified name", () => {
    const pool = mockPool()
    const server = makeServer({ slug: "my-srv" })
    const tool = makeTool({ name: "read_file" })

    const def = createMcpToolDefinition(pool, server, tool)

    expect(def.name).toBe("mcp:my-srv:read_file")
  })

  it("uses tool description when available", () => {
    const pool = mockPool()
    const server = makeServer()
    const tool = makeTool({ description: "Custom description" })

    const def = createMcpToolDefinition(pool, server, tool)

    expect(def.description).toBe("Custom description")
  })

  it("falls back to auto-generated description when null", () => {
    const pool = mockPool()
    const server = makeServer({ name: "Cool Server" })
    const tool = makeTool({ name: "write_file", description: null })

    const def = createMcpToolDefinition(pool, server, tool)

    expect(def.description).toBe("MCP tool write_file from Cool Server")
  })

  it("uses the tool input_schema", () => {
    const pool = mockPool()
    const schema = {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path"],
    }
    const tool = makeTool({ input_schema: schema })

    const def = createMcpToolDefinition(pool, makeServer(), tool)

    expect(def.inputSchema).toEqual(schema)
  })

  it("delegates execution to client pool with correct args", async () => {
    const callTool = vi.fn().mockResolvedValue({ output: "tool-result", isError: false })
    const pool: McpClientPool = {
      callTool,
      isConnected: vi.fn().mockReturnValue(true),
      connect: vi.fn().mockResolvedValue({}),
    }
    const server = makeServer({ id: "srv-id-001", slug: "srv-1" })
    const tool = makeTool({ name: "search" })

    const def = createMcpToolDefinition(pool, server, tool)
    const result = await def.execute({ query: "hello" })

    expect(callTool).toHaveBeenCalledWith("srv-id-001", "search", { query: "hello" })
    expect(result).toBe("tool-result")
  })

  it("propagates errors from pool.callTool", async () => {
    const pool: McpClientPool = {
      callTool: vi.fn().mockRejectedValue(new Error("connection refused")),
      isConnected: vi.fn().mockReturnValue(true),
      connect: vi.fn().mockResolvedValue({}),
    }
    const def = createMcpToolDefinition(pool, makeServer(), makeTool())

    await expect(def.execute({})).rejects.toThrow("connection refused")
  })
})
