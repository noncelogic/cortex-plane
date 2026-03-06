/**
 * MCP E2E Integration Tests
 *
 * Validates end-to-end flows across McpClientPool, McpToolRouter,
 * McpHealthSupervisor, and the tool bridge.  External I/O (MCP SDK
 * transports, k8s exec) is mocked; internal wiring is real.
 *
 * Scenarios:
 *   1. GitHub MCP Server  — Streamable HTTP transport
 *   2. Filesystem MCP Server — stdio transport (sidecar)
 *   3. Health probing & circuit breaker recovery
 *   4. Tool conflict resolution across multiple servers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock MCP SDK — vi.hoisted avoids TDZ errors
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
} = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockCallTool: vi.fn(),
  mockListTools: vi.fn(),
  mockPing: vi.fn().mockResolvedValue({}),
  mockGetServerVersion: vi.fn().mockReturnValue({ name: "test-server", version: "1.0.0" }),
  mockGetServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
  mockHttpTransportConstructor: vi.fn(),
  mockStdioTransportConstructor: vi.fn(),
}))

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
import {
  circuitStateToMcpStatus,
  McpHealthSupervisor,
  type McpHealthSupervisorDeps,
  type ProbeFn,
} from "../mcp/health-supervisor.js"
import { createMcpToolDefinition, parseQualifiedName, qualifiedName } from "../mcp/tool-bridge.js"
import { McpToolRouter, type McpToolRouterDeps } from "../mcp/tool-router.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-e2e-001"

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-github-uuid",
    name: "GitHub MCP",
    slug: "github",
    transport: "streamable-http",
    connection: { url: "https://mcp-github.internal/mcp" },
    agent_scope: [],
    description: "GitHub tools via MCP",
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

function makeFilesystemServer(overrides: Partial<McpServer> = {}): McpServer {
  return makeServer({
    id: "srv-fs-uuid",
    name: "Filesystem MCP",
    slug: "filesystem",
    transport: "stdio",
    connection: { command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/workspace"] },
    description: "Filesystem tools via stdio sidecar",
    ...overrides,
  })
}

/** Build a joined row as the tool router DB queries return. */
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
    transport?: string
    connection?: Record<string, unknown>
  } = {},
) {
  const {
    toolName = "list_issues",
    serverSlug = "github",
    serverId = "srv-github-uuid",
    serverCreatedAt = new Date("2025-01-01T00:00:00Z"),
    agentScope = [],
    serverStatus = "ACTIVE",
    toolStatus = "available",
    description = "List issues in a repository",
    inputSchema = { type: "object", properties: { repo: { type: "string" } } },
    transport = "streamable-http",
    connection = { url: "https://mcp-github.internal/mcp" },
  } = overrides

  return {
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
    server_id: serverId,
    server_name: `Server ${serverSlug}`,
    server_slug: serverSlug,
    server_transport: transport,
    server_connection: connection,
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

/** Create a mock Kysely db returning specified rows. */
function mockDb(rows: ReturnType<typeof makeRow>[]) {
  const execute = vi.fn().mockResolvedValue(rows)
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? undefined)
  const orderBy = vi.fn().mockReturnValue({ execute, executeTakeFirst })
  const where = vi.fn()

  where.mockReturnValue({ where, orderBy, execute, executeTakeFirst })

  const selectFn = vi.fn().mockReturnValue({ where, orderBy, execute, executeTakeFirst })
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

  // Update chain for health supervisor
  const updateExecute = vi.fn().mockResolvedValue(undefined)
  const updateWhere = vi.fn().mockReturnValue({ execute: updateExecute })
  const set = vi.fn().mockReturnValue({ where: updateWhere })
  const updateTable = vi.fn().mockReturnValue({ set })

  return {
    selectFrom,
    updateTable,
    _execute: execute,
    _set: set,
  } as unknown as McpToolRouterDeps["db"] & {
    _execute: ReturnType<typeof vi.fn>
    _set: ReturnType<typeof vi.fn>
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()

  mockConnect.mockResolvedValue(undefined)
  mockClose.mockResolvedValue(undefined)
  mockPing.mockResolvedValue({})
  mockGetServerVersion.mockReturnValue({ name: "test-server", version: "1.0.0" })
  mockGetServerCapabilities.mockReturnValue({ tools: {} })

  // Default: GitHub tools
  mockListTools.mockResolvedValue({
    tools: [
      {
        name: "list_issues",
        description: "List issues in a repository",
        inputSchema: { type: "object", properties: { repo: { type: "string" } } },
      },
      {
        name: "create_issue",
        description: "Create a new issue",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string" }, title: { type: "string" } },
        },
      },
      {
        name: "search_code",
        description: "Search code in a repository",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  })

  mockCallTool.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify([{ number: 1, title: "Bug fix" }]) }],
    isError: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1: GitHub MCP Server (Streamable HTTP)
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E — GitHub MCP Server (Streamable HTTP)", () => {
  it("connects, discovers tools, and executes a tool call", async () => {
    const pool = new McpClientPool()
    const server = makeServer()

    // 1. Connect and verify handshake
    const conn = await pool.connect(server)
    expect(conn.serverId).toBe(server.id)
    expect(conn.transport).toBe("streamable-http")
    expect(conn.serverInfo.name).toBe("test-server")
    expect(mockHttpTransportConstructor).toHaveBeenCalledOnce()

    // 2. Discover tools
    const tools = await pool.listTools(server.id)
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_issues", "create_issue", "search_code"]),
    )

    // 3. Execute a tool call through the bridge
    const toolDef = createMcpToolDefinition(pool, server, {
      id: "tool-1",
      mcp_server_id: server.id,
      name: "list_issues",
      qualified_name: "mcp:github:list_issues",
      description: "List issues",
      input_schema: { type: "object", properties: { repo: { type: "string" } } },
      annotations: null,
      status: "available",
      created_at: new Date(),
      updated_at: new Date(),
    } as never)

    expect(toolDef.name).toBe("mcp:github:list_issues")
    const output = await toolDef.execute({ repo: "noncelogic/cortex-plane" })
    expect(output).toContain("Bug fix")
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: "list_issues", arguments: { repo: "noncelogic/cortex-plane" } },
      undefined,
      expect.objectContaining({ timeout: 30_000 }),
    )

    // 4. Verify health probe succeeds
    const ping = await pool.ping(server.id)
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0)

    await pool.disconnectAll()
  })

  it("routes tool calls via McpToolRouter with glob patterns", async () => {
    const rows = [
      makeRow({ toolName: "list_issues", serverSlug: "github" }),
      makeRow({ toolName: "create_issue", serverSlug: "github" }),
      makeRow({ toolName: "search_code", serverSlug: "github" }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    // Resolve all GitHub tools via glob
    const tools = await router.resolveAll(AGENT_ID, ["mcp:github:*"], [])
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "mcp:github:list_issues",
        "mcp:github:create_issue",
        "mcp:github:search_code",
      ]),
    )

    // Resolve a single qualified tool
    const single = await router.resolve("mcp:github:list_issues", AGENT_ID)
    expect(single).not.toBeNull()
    expect(single!.name).toBe("mcp:github:list_issues")
  })

  it("full pipeline: register → resolve → execute → verify output", async () => {
    const pool = new McpClientPool()
    const server = makeServer()

    // Register (connect)
    await pool.connect(server)

    // Set up router
    const rows = [makeRow({ toolName: "list_issues", serverSlug: "github" })]
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    // Resolve via router
    const toolDef = await router.resolve("mcp:github:list_issues", AGENT_ID)
    expect(toolDef).not.toBeNull()

    // Execute
    const output = await toolDef!.execute({ repo: "noncelogic/cortex-plane" })
    expect(output).toContain("Bug fix")

    await pool.disconnectAll()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2: Filesystem MCP Server (stdio, sidecar)
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E — Filesystem MCP Server (stdio)", () => {
  beforeEach(() => {
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "write_file",
          description: "Write a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
        },
        {
          name: "search_files",
          description: "Search files",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
    })

    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "# README\nWelcome to cortex-plane" }],
      isError: false,
    })
  })

  it("connects via stdio transport, discovers tools, and reads a file", async () => {
    const pool = new McpClientPool()
    const server = makeFilesystemServer()

    // 1. Connect via stdio
    const conn = await pool.connect(server)
    expect(conn.transport).toBe("stdio")
    expect(mockStdioTransportConstructor).toHaveBeenCalledOnce()
    expect(mockStdioTransportConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npx",
        args: ["@modelcontextprotocol/server-filesystem", "/workspace"],
      }),
    )

    // 2. Discover tools
    const tools = await pool.listTools(server.id)
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toContain("read_file")
    expect(tools.map((t) => t.name)).toContain("write_file")
    expect(tools.map((t) => t.name)).toContain("search_files")

    // 3. Execute read_file
    const result = await pool.callTool(server.id, "read_file", { path: "/workspace/README.md" })
    expect(result.isError).toBe(false)
    expect(result.output).toContain("README")
    expect(result.output).toContain("cortex-plane")

    await pool.disconnectAll()
  })

  it("routes filesystem tools with deny filter", async () => {
    const rows = [
      makeRow({
        toolName: "read_file",
        serverSlug: "filesystem",
        serverId: "srv-fs-uuid",
        transport: "stdio",
        connection: { command: "npx", args: ["@modelcontextprotocol/server-filesystem"] },
      }),
      makeRow({
        toolName: "write_file",
        serverSlug: "filesystem",
        serverId: "srv-fs-uuid",
        transport: "stdio",
        connection: { command: "npx", args: ["@modelcontextprotocol/server-filesystem"] },
      }),
      makeRow({
        toolName: "search_files",
        serverSlug: "filesystem",
        serverId: "srv-fs-uuid",
        transport: "stdio",
        connection: { command: "npx", args: ["@modelcontextprotocol/server-filesystem"] },
      }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    // Allow all filesystem tools but deny write_file
    const tools = await router.resolveAll(
      AGENT_ID,
      ["mcp:filesystem:*"],
      ["mcp:filesystem:write_file"],
    )
    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.name)).toContain("mcp:filesystem:read_file")
    expect(tools.map((t) => t.name)).toContain("mcp:filesystem:search_files")
    expect(tools.map((t) => t.name)).not.toContain("mcp:filesystem:write_file")
  })

  it("full pipeline: connect → resolve → read_file → verify result", async () => {
    const pool = new McpClientPool()
    const server = makeFilesystemServer()
    await pool.connect(server)

    const rows = [
      makeRow({
        toolName: "read_file",
        serverSlug: "filesystem",
        serverId: "srv-fs-uuid",
        transport: "stdio",
      }),
    ]
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    const toolDef = await router.resolve("mcp:filesystem:read_file", AGENT_ID)
    expect(toolDef).not.toBeNull()

    const output = await toolDef!.execute({ path: "/workspace/README.md" })
    expect(output).toContain("cortex-plane")

    await pool.disconnectAll()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3: Health and Recovery
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E — Health probing and circuit breaker recovery", () => {
  function buildSupervisor(opts: {
    servers: ReturnType<typeof makeServer>[]
    probeFn?: ProbeFn
    defaultProbeIntervalMs?: number
    cbConfig?: Record<string, number>
  }) {
    // Override selectAll → where chain to return server list
    const serverRows = opts.servers
    const selectExecute = vi.fn().mockResolvedValue(serverRows)
    const selectWhere = vi.fn().mockReturnValue({ where: vi.fn(), execute: selectExecute })
    const selectAll = vi.fn().mockReturnValue({ where: selectWhere, execute: selectExecute })
    const selectFrom = vi.fn().mockReturnValue({ selectAll })

    const updateExecute = vi.fn().mockResolvedValue(undefined)
    const updateWhere = vi.fn().mockReturnValue({ execute: updateExecute })
    const set = vi.fn().mockReturnValue({ where: updateWhere })
    const updateTable = vi.fn().mockReturnValue({ set })

    const dbMock = {
      selectFrom,
      updateTable,
      _set: set,
    } as unknown as McpHealthSupervisorDeps["db"]

    const probeFn = opts.probeFn ?? vi.fn().mockResolvedValue(undefined)
    const sseManager = {
      broadcast: vi.fn(),
    } as unknown as McpHealthSupervisorDeps["sseManager"] & {
      broadcast: ReturnType<typeof vi.fn>
    }

    const supervisor = new McpHealthSupervisor({
      db: dbMock,
      sseManager,
      probeFn,
      defaultProbeIntervalMs: opts.defaultProbeIntervalMs ?? 100,
      circuitBreakerConfig: opts.cbConfig,
    })

    return { supervisor, db: dbMock, sseManager, probeFn: probeFn as ReturnType<typeof vi.fn> }
  }

  it("ACTIVE → DEGRADED → ERROR → recovery flow", async () => {
    const server = makeServer({ status: "PENDING", health_probe_interval_ms: 100 })
    let shouldFail = false
    const probeFn = vi.fn().mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error("connection refused"))
      return Promise.resolve()
    })

    const { supervisor, sseManager } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: {
        failureThreshold: 3,
        windowMs: 60_000,
        openDurationMs: 500,
        halfOpenMaxAttempts: 1,
        successThresholdToClose: 1,
      },
    })

    // Phase 1: healthy probes → ACTIVE
    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(supervisor.getServerState(server.id)!.status).toBe("ACTIVE")

    // Phase 2: failures accumulate
    shouldFail = true
    await vi.advanceTimersByTimeAsync(100) // failure 1
    expect(supervisor.getServerState(server.id)!.consecutiveFailures).toBe(1)

    await vi.advanceTimersByTimeAsync(100) // failure 2
    expect(supervisor.getServerState(server.id)!.consecutiveFailures).toBe(2)

    await vi.advanceTimersByTimeAsync(100) // failure 3 → circuit OPEN → ERROR
    expect(supervisor.getServerState(server.id)!.status).toBe("ERROR")

    // Phase 3: recovery — restore server
    shouldFail = false
    // Wait for openDurationMs to elapse → HALF_OPEN, then next probe → ACTIVE
    await vi.advanceTimersByTimeAsync(600)
    expect(supervisor.getServerState(server.id)!.status).toBe("ACTIVE")
    expect(supervisor.getServerState(server.id)!.consecutiveFailures).toBe(0)

    // SSE should have broadcast status changes
    const sseMock = sseManager as unknown as { broadcast: ReturnType<typeof vi.fn> }
    expect(sseMock.broadcast.mock.calls.length).toBeGreaterThan(0)

    supervisor.stop()
  })

  it("circuit breaker skips probes when OPEN", async () => {
    const server = makeServer({ status: "PENDING", health_probe_interval_ms: 100 })
    let callCount = 0
    const probeFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.reject(new Error("fail"))
    })

    const { supervisor } = buildSupervisor({
      servers: [server],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: {
        failureThreshold: 1,
        windowMs: 60_000,
        openDurationMs: 10_000,
        halfOpenMaxAttempts: 1,
        successThresholdToClose: 1,
      },
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0) // 1 failure → OPEN
    expect(callCount).toBe(1)

    // Further ticks should skip (circuit OPEN)
    await vi.advanceTimersByTimeAsync(500)
    expect(callCount).toBe(1) // no new probes

    supervisor.stop()
  })

  it("health report reflects mixed status", async () => {
    const github = makeServer({ id: "gh-1", slug: "github", health_probe_interval_ms: 100 })
    const fs = makeServer({ id: "fs-1", slug: "filesystem", health_probe_interval_ms: 100 })

    let probeNum = 0
    const probeFn = vi.fn().mockImplementation(() => {
      probeNum++
      // Fail filesystem server (even-numbered probe)
      if (probeNum % 2 === 0) return Promise.reject(new Error("fs down"))
      return Promise.resolve()
    })

    const { supervisor } = buildSupervisor({
      servers: [github, fs],
      probeFn,
      defaultProbeIntervalMs: 100,
      cbConfig: { failureThreshold: 1, openDurationMs: 60_000 },
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    const report = supervisor.getHealthReport()
    const statuses = report.servers.map((s) => s.status)
    expect(statuses).toContain("ACTIVE")
    expect(statuses).toContain("ERROR")
    expect(report.status).toBe("degraded")

    supervisor.stop()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4: Tool Conflict Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E — Tool conflict resolution", () => {
  it("two servers expose same tool → unqualified call raises ambiguity error", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rows = [
      makeRow({
        toolName: "search",
        serverSlug: "github",
        serverId: "gh-1",
        serverCreatedAt: sameTime,
      }),
      makeRow({
        toolName: "search",
        serverSlug: "jira",
        serverId: "jira-1",
        serverCreatedAt: sameTime,
      }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    // Unqualified → ambiguity
    await expect(router.resolve("search", AGENT_ID)).rejects.toThrow(/Ambiguous tool name "search"/)
  })

  it("qualified name bypasses conflict — github", async () => {
    const githubRow = makeRow({
      toolName: "search",
      serverSlug: "github",
      serverId: "gh-1",
    })
    const pool = new McpClientPool()
    const db = mockDb([githubRow])
    const router = new McpToolRouter({ db, clientPool: pool })

    const result = await router.resolve("mcp:github:search", AGENT_ID)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:github:search")
  })

  it("qualified name bypasses conflict — jira", async () => {
    const jiraRow = makeRow({
      toolName: "search",
      serverSlug: "jira",
      serverId: "jira-1",
    })
    const pool = new McpClientPool()
    const db = mockDb([jiraRow])
    const router = new McpToolRouter({ db, clientPool: pool })

    const result = await router.resolve("mcp:jira:search", AGENT_ID)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:jira:search")
  })

  it("agent_scope restricts to one server → resolves without ambiguity", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rows = [
      makeRow({
        toolName: "deploy",
        serverSlug: "github",
        serverId: "gh-1",
        serverCreatedAt: sameTime,
        agentScope: [],
      }),
      makeRow({
        toolName: "deploy",
        serverSlug: "internal-ci",
        serverId: "ci-1",
        serverCreatedAt: sameTime,
        agentScope: [AGENT_ID],
      }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    const result = await router.resolve("deploy", AGENT_ID)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("mcp:internal-ci:deploy")
  })

  it("server_priority resolves conflict via agent preference", async () => {
    const sameTime = new Date("2025-01-01T00:00:00Z")
    const rows = [
      makeRow({
        toolName: "exec",
        serverSlug: "server-a",
        serverId: "id-a",
        serverCreatedAt: sameTime,
      }),
      makeRow({
        toolName: "exec",
        serverSlug: "server-b",
        serverId: "id-b",
        serverCreatedAt: sameTime,
      }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    const agentConfig = {
      mcp_preferences: { server_priority: ["server-b"] },
    }

    const result = await router.resolve("exec", AGENT_ID, agentConfig)
    expect(result!.name).toBe("mcp:server-b:exec")
  })

  it("resolveAll with scope filters tools for the correct agent", async () => {
    const rows = [
      makeRow({
        toolName: "tool_a",
        serverSlug: "srv-public",
        serverId: "pub-1",
        agentScope: [],
      }),
      makeRow({
        toolName: "tool_b",
        serverSlug: "srv-private",
        serverId: "priv-1",
        agentScope: [AGENT_ID],
      }),
      makeRow({
        toolName: "tool_c",
        serverSlug: "srv-other",
        serverId: "other-1",
        agentScope: ["other-agent"],
      }),
    ]
    const pool = new McpClientPool()
    const db = mockDb(rows)
    const router = new McpToolRouter({ db, clientPool: pool })

    const tools = await router.resolveAll(AGENT_ID, [], [])
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect(names).toContain("mcp:srv-public:tool_a")
    expect(names).toContain("mcp:srv-private:tool_b")
    expect(names).not.toContain("mcp:srv-other:tool_c")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════════════════════

describe("E2E — utility function validation", () => {
  it("qualifiedName builds correct format", () => {
    expect(qualifiedName("github", "list_issues")).toBe("mcp:github:list_issues")
    expect(qualifiedName("filesystem", "read_file")).toBe("mcp:filesystem:read_file")
  })

  it("parseQualifiedName extracts slug and tool", () => {
    const result = parseQualifiedName("mcp:github:list_issues")
    expect(result).toEqual({ serverSlug: "github", toolName: "list_issues" })
  })

  it("parseQualifiedName returns null for non-MCP names", () => {
    expect(parseQualifiedName("list_issues")).toBeNull()
    expect(parseQualifiedName("webhook:list_issues")).toBeNull()
    expect(parseQualifiedName("mcp:")).toBeNull()
    expect(parseQualifiedName("mcp:github:")).toBeNull()
  })

  it("circuitStateToMcpStatus maps all states", () => {
    expect(circuitStateToMcpStatus("CLOSED")).toBe("ACTIVE")
    expect(circuitStateToMcpStatus("HALF_OPEN")).toBe("DEGRADED")
    expect(circuitStateToMcpStatus("OPEN")).toBe("ERROR")
  })
})
