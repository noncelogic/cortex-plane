/**
 * MCP Client Pool — unit tests
 *
 * All transport-level I/O is mocked via vi.mock so no real network or
 * child processes are created.  The tests cover:
 *
 *   - connect / disconnect / disconnectAll lifecycle
 *   - maxConnections enforcement
 *   - callTool: happy path, timeout, reconnect-on-transport-error
 *   - listTools
 *   - ping
 *   - status queries (isConnected, getConnection, getConnectionCount)
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock @modelcontextprotocol/sdk — must use vi.hoisted to avoid TDZ errors
// ---------------------------------------------------------------------------

const {
  mockConnect,
  mockClose,
  mockCallTool,
  mockListTools,
  mockPing,
  mockGetServerVersion,
  mockGetServerCapabilities,
  mockHttpTransportConstructor,
  mockStdioTransportConstructor,
} = vi.hoisted(() => {
  return {
    mockConnect: vi.fn().mockResolvedValue(undefined),
    mockClose: vi.fn().mockResolvedValue(undefined),
    mockCallTool: vi.fn(),
    mockListTools: vi.fn(),
    mockPing: vi.fn().mockResolvedValue({}),
    mockGetServerVersion: vi.fn().mockReturnValue({ name: "test-server", version: "1.0.0" }),
    mockGetServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    mockHttpTransportConstructor: vi.fn(),
    mockStdioTransportConstructor: vi.fn(),
  }
})

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class FakeClient {
    connect = mockConnect
    close = mockClose
    callTool = mockCallTool
    listTools = mockListTools
    ping = mockPing
    getServerVersion = mockGetServerVersion
    getServerCapabilities = mockGetServerCapabilities
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: mockHttpTransportConstructor,
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mockStdioTransportConstructor,
}))

import type { McpServer } from "../db/types.js"
import { McpClientPool } from "../mcp/client-pool.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHttpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-http-uuid-001",
    name: "Test HTTP Server",
    slug: "test-http",
    transport: "streamable-http",
    connection: { url: "https://mcp.example.com/mcp" },
    agent_scope: [],
    description: null,
    status: "ACTIVE",
    protocol_version: null,
    server_info: null,
    capabilities: null,
    health_probe_interval_ms: 30_000,
    last_healthy_at: null,
    error_message: null,
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-01"),
    ...overrides,
  } as McpServer
}

function makeStdioServer(overrides: Partial<McpServer> = {}): McpServer {
  return makeHttpServer({
    id: "srv-stdio-uuid-002",
    name: "Test stdio Server",
    slug: "test-stdio",
    transport: "stdio",
    connection: { command: "npx", args: ["some-mcp-server"] },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockResolvedValue(undefined)
  mockCallTool.mockResolvedValue({
    content: [{ type: "text", text: "tool output" }],
    isError: false,
  })
  mockListTools.mockResolvedValue({
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        annotations: { readOnlyHint: true },
      },
    ],
  })
  mockPing.mockResolvedValue({})
  mockGetServerVersion.mockReturnValue({ name: "test-server", version: "1.0.0" })
  mockGetServerCapabilities.mockReturnValue({ tools: {} })
})

// ═══════════════════════════════════════════════════════════════════════════
// connect
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool.connect — Streamable HTTP", () => {
  it("creates transport with URL and MCP headers", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()

    await pool.connect(server)

    expect(mockHttpTransportConstructor).toHaveBeenCalledOnce()
    const callUrl = mockHttpTransportConstructor.mock.calls[0]?.[0] as URL
    const callOpts = mockHttpTransportConstructor.mock.calls[0]?.[1] as {
      requestInit: { headers: Record<string, string> }
    }
    expect(callUrl.href).toBe("https://mcp.example.com/mcp")
    expect(callOpts.requestInit.headers["MCP-Protocol-Version"]).toBe("2025-11-25")
    expect(callOpts.requestInit.headers["Origin"]).toBe("https://cortex-plane.local")
  })

  it("returns connection metadata from server handshake", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()

    const conn = await pool.connect(server)

    expect(conn.serverId).toBe(server.id)
    expect(conn.transport).toBe("streamable-http")
    expect(conn.serverInfo.name).toBe("test-server")
    expect(conn.serverInfo.version).toBe("1.0.0")
    expect(conn.connectedAt).toBeInstanceOf(Date)
  })

  it("falls back to server.name when SDK returns no version", async () => {
    mockGetServerVersion.mockReturnValue(undefined)
    const pool = new McpClientPool()
    const server = makeHttpServer()

    const conn = await pool.connect(server)

    expect(conn.serverInfo.name).toBe(server.name)
    expect(conn.serverInfo.version).toBe("unknown")
  })

  it("throws when server has no URL", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer({ connection: {} })

    await expect(pool.connect(server)).rejects.toThrow(/no connection URL/)
  })

  it("returns existing connection on duplicate connect", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()

    const conn1 = await pool.connect(server)
    const conn2 = await pool.connect(server)

    expect(conn1).toBe(conn2)
    expect(mockConnect).toHaveBeenCalledOnce()
  })

  it("enforces maxConnections limit", async () => {
    const pool = new McpClientPool({ maxConnections: 1 })
    await pool.connect(makeHttpServer())
    await expect(pool.connect(makeHttpServer({ id: "srv-2", slug: "srv-2" }))).rejects.toThrow(
      /max connections/,
    )
  })

  it("concurrent connects to same server reuse single connection", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()

    const [conn1, conn2] = await Promise.all([pool.connect(server), pool.connect(server)])

    expect(conn1).toBe(conn2)
    expect(mockConnect).toHaveBeenCalledOnce()
  })
})

describe("McpClientPool.connect — stdio", () => {
  it("creates StdioClientTransport with command and args", async () => {
    const pool = new McpClientPool()
    const server = makeStdioServer()

    await pool.connect(server)

    expect(mockStdioTransportConstructor).toHaveBeenCalledOnce()
    expect(mockStdioTransportConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npx", args: ["some-mcp-server"] }),
    )
  })

  it("throws when server has no stdio command", async () => {
    const pool = new McpClientPool()
    const server = makeStdioServer({ connection: {} })

    await expect(pool.connect(server)).rejects.toThrow(/no stdio command/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// disconnect / disconnectAll
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool.disconnect", () => {
  it("closes the SDK client and removes the entry", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    await pool.disconnect(server.id)

    expect(mockClose).toHaveBeenCalledOnce()
    expect(pool.isConnected(server.id)).toBe(false)
  })

  it("is a no-op for unknown serverId", async () => {
    const pool = new McpClientPool()

    await expect(pool.disconnect("nonexistent")).resolves.toBeUndefined()
    expect(mockClose).not.toHaveBeenCalled()
  })
})

describe("McpClientPool.disconnectAll", () => {
  it("closes all active connections", async () => {
    const pool = new McpClientPool()
    await pool.connect(makeHttpServer())
    await pool.connect(makeStdioServer())

    expect(pool.getConnectionCount()).toBe(2)

    await pool.disconnectAll()

    expect(mockClose).toHaveBeenCalledTimes(2)
    expect(pool.getConnectionCount()).toBe(0)
  })

  it("resolves even when close throws", async () => {
    mockClose.mockRejectedValueOnce(new Error("close failed"))
    const pool = new McpClientPool()
    await pool.connect(makeHttpServer())

    await expect(pool.disconnectAll()).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// callTool
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool.callTool", () => {
  it("returns text content from tool result", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "read_file", { path: "/etc/hosts" })

    expect(result).toEqual({ output: "tool output", isError: false })
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: "read_file", arguments: { path: "/etc/hosts" } },
      undefined,
      expect.objectContaining({ timeout: 30_000 }),
    )
  })

  it("joins multiple text content items", async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
      isError: false,
    })
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "multi", {})

    expect(result.output).toBe("line 1\nline 2")
  })

  it("passes isError flag through", async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "error occurred" }],
      isError: true,
    })
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "bad_tool", {})

    expect(result.isError).toBe(true)
    expect(result.output).toBe("error occurred")
  })

  it("falls back to JSON for non-text content", async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
      isError: false,
    })
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "screenshot", {})

    expect(result.output).toContain("image")
    expect(result.isError).toBe(false)
  })

  it("returns timeout error when SDK times out", async () => {
    const timeoutErr = new Error("Request timed out after 100ms")
    mockCallTool.mockRejectedValueOnce(timeoutErr)
    const pool = new McpClientPool({ defaultTimeoutMs: 100 })
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "slow_tool", {})

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/Timeout after 100ms/)
  })

  it("respects per-call timeoutMs option", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    await pool.callTool(server.id, "tool", {}, { timeoutMs: 5000 })

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ timeout: 5000 }),
    )
  })

  it("throws when server not connected", async () => {
    const pool = new McpClientPool()

    await expect(pool.callTool("nonexistent-id", "tool", {})).rejects.toThrow(
      /no active connection/,
    )
  })

  it("reconnects and retries on transport error using original server config", async () => {
    const transportErr = new Error("connection reset")
    mockCallTool
      .mockRejectedValueOnce(transportErr)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "retry-output" }], isError: false })

    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.callTool(server.id, "tool", {})

    expect(result).toEqual({ output: "retry-output", isError: false })
    // Transport rebuilt — connect called twice (initial + reconnect)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    // URL-based transport rebuilt from stored server config
    expect(mockHttpTransportConstructor).toHaveBeenCalledTimes(2)
  })

  it("throws retry error when reconnect and retry both fail", async () => {
    const transportErr = new Error("connection reset")
    const retryErr = new Error("retry also failed")
    mockCallTool.mockRejectedValueOnce(transportErr).mockRejectedValueOnce(retryErr)

    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    await expect(pool.callTool(server.id, "tool", {})).rejects.toThrow("retry also failed")
    expect(pool.isConnected(server.id)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// listTools
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool.listTools", () => {
  it("returns mapped McpToolInfo array", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const tools = await pool.listTools(server.id)

    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe("read_file")
    expect(tools[0]!.description).toBe("Read a file")
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" })
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true })
  })

  it("maps null description when missing", async () => {
    mockListTools.mockResolvedValueOnce({
      tools: [{ name: "no_desc", inputSchema: { type: "object" } }],
    })
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const tools = await pool.listTools(server.id)

    expect(tools[0]!.description).toBeNull()
    expect(tools[0]!.annotations).toBeUndefined()
  })

  it("throws when server not connected", async () => {
    const pool = new McpClientPool()

    await expect(pool.listTools("nonexistent")).rejects.toThrow(/no active connection/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ping
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool.ping", () => {
  it("returns latencyMs as a number", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const result = await pool.ping(server.id)

    expect(typeof result.latencyMs).toBe("number")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("throws when server not connected", async () => {
    const pool = new McpClientPool()

    await expect(pool.ping("nonexistent")).rejects.toThrow(/no active connection/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Status queries
// ═══════════════════════════════════════════════════════════════════════════

describe("McpClientPool — status queries", () => {
  it("isConnected returns false before connect", () => {
    const pool = new McpClientPool()
    expect(pool.isConnected("srv-http-uuid-001")).toBe(false)
  })

  it("isConnected returns true after connect", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)
    expect(pool.isConnected(server.id)).toBe(true)
  })

  it("getConnection returns undefined when not connected", () => {
    const pool = new McpClientPool()
    expect(pool.getConnection("nonexistent")).toBeUndefined()
  })

  it("getConnection returns connection metadata", async () => {
    const pool = new McpClientPool()
    const server = makeHttpServer()
    await pool.connect(server)

    const conn = pool.getConnection(server.id)

    expect(conn).toBeDefined()
    expect(conn!.serverId).toBe(server.id)
  })

  it("getConnectionCount tracks connections", async () => {
    const pool = new McpClientPool()
    expect(pool.getConnectionCount()).toBe(0)

    await pool.connect(makeHttpServer())
    expect(pool.getConnectionCount()).toBe(1)

    await pool.connect(makeStdioServer())
    expect(pool.getConnectionCount()).toBe(2)

    await pool.disconnect(makeHttpServer().id)
    expect(pool.getConnectionCount()).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Integration placeholder — real MCP server
// ═══════════════════════════════════════════════════════════════════════════

describe.skip("McpClientPool — integration (real MCP server)", () => {
  it("connects to a local MCP server and calls a tool", async () => {
    // TODO: Start a real MCP server (e.g. npx @modelcontextprotocol/server-everything)
    // and verify full round-trip with actual transport.
  })
})
