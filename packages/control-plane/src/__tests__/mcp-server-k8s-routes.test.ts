import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database, McpServerStatus } from "../db/types.js"
import type { McpServerDeployer } from "../mcp/k8s-deployer.js"
import type { AuthConfig } from "../middleware/types.js"
import { mcpServerRoutes } from "../routes/mcp-servers.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const TEST_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

function makeMcpServer(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_UUID,
    name: "GitHub MCP",
    slug: "github-mcp",
    transport: "streamable-http",
    connection: {
      image: "ghcr.io/modelcontextprotocol/server-github:latest",
      port: 3000,
    },
    agent_scope: [],
    description: null,
    status: "PENDING" as McpServerStatus,
    protocol_version: null,
    server_info: null,
    capabilities: null,
    health_probe_interval_ms: 30000,
    last_healthy_at: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

/** Build a chainable mock that simulates Kysely's fluent query API. */
function mockDb(
  opts: {
    servers?: Record<string, unknown>[]
    insertedServer?: Record<string, unknown>
    updatedServer?: Record<string, unknown> | null
    insertError?: Error
  } = {},
) {
  const {
    servers = [makeMcpServer()],
    insertedServer = makeMcpServer(),
    updatedServer = makeMcpServer(),
    insertError,
  } = opts

  function selectChain(rows: Record<string, unknown>[]) {
    const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(rows[0] ?? {})
    const execute = vi.fn().mockResolvedValue(rows)
    const terminal = { execute, executeTakeFirst, executeTakeFirstOrThrow }
    const offset = vi.fn().mockReturnValue(terminal)
    const limit = vi.fn().mockReturnValue({ ...terminal, offset })
    const orderBy = vi.fn().mockReturnValue({ ...terminal, limit, offset })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({
      where: whereFn,
      orderBy,
      limit,
      offset,
      ...terminal,
    })
    const selectAll = vi
      .fn()
      .mockReturnValue({ where: whereFn, orderBy, limit, offset, ...terminal })
    const countResult = { total: rows.length }
    const selectTerminal = {
      executeTakeFirst,
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue(countResult),
      execute,
    }
    const selectWhereFn: ReturnType<typeof vi.fn> = vi.fn()
    selectWhereFn.mockReturnValue({
      where: selectWhereFn,
      ...selectTerminal,
    })
    const select = vi.fn().mockReturnValue({ where: selectWhereFn, ...selectTerminal })
    return { selectAll, select }
  }

  function insertChain(row: Record<string, unknown>, error?: Error) {
    const executeTakeFirstOrThrow = error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(row)
    const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
    const values = vi.fn().mockReturnValue({ returningAll })
    return { values }
  }

  function updateChain(row: Record<string, unknown> | null) {
    const executeTakeFirst = vi.fn().mockResolvedValue(row)
    const execute = vi.fn().mockResolvedValue(row ? [row] : [])
    const returningAll = vi.fn().mockReturnValue({ executeTakeFirst })
    const where = vi.fn().mockReturnValue({
      returningAll,
      execute,
      where: vi.fn().mockReturnValue({ returningAll, execute }),
    })
    const set = vi.fn().mockReturnValue({ where })
    return { set }
  }

  function deleteChain(row: Record<string, unknown> | null) {
    const executeTakeFirst = vi.fn().mockResolvedValue(row)
    const returningAll = vi.fn().mockReturnValue({ executeTakeFirst })
    const where = vi.fn().mockReturnValue({ returningAll })
    return { where }
  }

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "mcp_server") return selectChain(servers)
      return selectChain([])
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "mcp_server") return insertChain(insertedServer, insertError)
      return insertChain({})
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      if (table === "mcp_server") return updateChain(updatedServer)
      return updateChain(null)
    }),
    deleteFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "mcp_server") return deleteChain(servers[0] ?? null)
      return deleteChain(null)
    }),
    fn: {
      countAll: () => ({
        as: () => "count(*) as total",
      }),
    },
  } as unknown as Kysely<Database>
}

function mockDeployer(overrides: Partial<McpServerDeployer> = {}): McpServerDeployer {
  return {
    deploy: vi.fn().mockResolvedValue({
      url: "http://mcp-server-github-mcp.cortex-plane.svc:3000/mcp",
      deploymentName: "mcp-server-github-mcp",
      serviceName: "mcp-server-github-mcp",
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ ready: true, availableReplicas: 1 }),
    ...overrides,
  } as unknown as McpServerDeployer
}

async function buildTestApp(
  dbOpts: Parameters<typeof mockDb>[0] = {},
  deployer?: McpServerDeployer,
) {
  const app = Fastify({ logger: false })
  const db = mockDb(dbOpts)

  await app.register(mcpServerRoutes({ db, authConfig: DEV_AUTH_CONFIG, mcpDeployer: deployer }))

  return { app, db }
}

// ---------------------------------------------------------------------------
// POST /mcp-servers with connection.image (in-cluster deployment)
// ---------------------------------------------------------------------------

describe("POST /mcp-servers — in-cluster deployment", () => {
  it("triggers k8s deployment when connection.image is provided", async () => {
    const deployer = mockDeployer()
    const { app } = await buildTestApp({}, deployer)

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "GitHub MCP",
        transport: "streamable-http",
        connection: {
          image: "ghcr.io/modelcontextprotocol/server-github:latest",
        },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.deploy).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.waitForReady).toHaveBeenCalledTimes(1)
  })

  it("passes port, resources, and env to deployer", async () => {
    const deployer = mockDeployer()
    const { app } = await buildTestApp({}, deployer)

    await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "GitHub MCP",
        transport: "streamable-http",
        connection: {
          image: "ghcr.io/modelcontextprotocol/server-github:latest",
          port: 8080,
          resources: { cpu: "500m", memory: "512Mi" },
          env: { GITHUB_TOKEN: "tok-abc" },
        },
      },
    })

    const deployCall = (deployer.deploy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ]
    expect(deployCall[0]).toEqual(
      expect.objectContaining({
        slug: "github-mcp",
        image: "ghcr.io/modelcontextprotocol/server-github:latest",
        port: 8080,
        resources: { cpu: "500m", memory: "512Mi" },
        env: { GITHUB_TOKEN: "tok-abc" },
      }) as Record<string, unknown>,
    )
  })

  it("returns 501 when deployer is not configured", async () => {
    // No deployer provided
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "GitHub MCP",
        transport: "streamable-http",
        connection: {
          image: "ghcr.io/modelcontextprotocol/server-github:latest",
        },
      },
    })

    expect(res.statusCode).toBe(501)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("not_implemented")
  })

  it("marks server as ERROR when deployment fails", async () => {
    const deployer = mockDeployer({
      deploy: vi.fn().mockRejectedValue(new Error("ImagePullBackOff")),
    } as Partial<McpServerDeployer>)
    const { app } = await buildTestApp({}, deployer)

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Bad Image",
        transport: "streamable-http",
        connection: {
          image: "nonexistent:latest",
        },
      },
    })

    // Server is still created but with error status
    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("ERROR")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error_message).toBe("ImagePullBackOff")
  })

  it("marks server as ERROR when readiness wait times out", async () => {
    const deployer = mockDeployer({
      waitForReady: vi.fn().mockRejectedValue(new Error("did not become ready within 120000ms")),
    } as Partial<McpServerDeployer>)
    const { app } = await buildTestApp({}, deployer)

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Slow Server",
        transport: "streamable-http",
        connection: {
          image: "slow-server:latest",
        },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("ERROR")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error_message).toContain("did not become ready")
  })

  it("does NOT trigger deployment for URL-only registration", async () => {
    const deployer = mockDeployer()
    const insertedServer = makeMcpServer({
      connection: { url: "https://example.com/mcp" },
    })
    const { app } = await buildTestApp({ insertedServer }, deployer)

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "External MCP",
        transport: "streamable-http",
        connection: { url: "https://example.com/mcp" },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.deploy).not.toHaveBeenCalled()
  })

  it("does NOT trigger deployment for stdio transport", async () => {
    const deployer = mockDeployer()
    const insertedServer = makeMcpServer({
      transport: "stdio",
      connection: { command: "node", args: ["server.js"] },
    })
    const { app } = await buildTestApp({ insertedServer }, deployer)

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Stdio Server",
        transport: "stdio",
        connection: { command: "node", args: ["server.js"], image: "some-image:latest" },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.deploy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DELETE /mcp-servers/:id — k8s cleanup
// ---------------------------------------------------------------------------

describe("DELETE /mcp-servers/:id — k8s cleanup", () => {
  it("tears down k8s resources for in-cluster server", async () => {
    const deployer = mockDeployer()
    const server = makeMcpServer({
      connection: {
        image: "ghcr.io/example:latest",
        url: "http://mcp-server-github-mcp.cortex-plane.svc:3000/mcp",
      },
    })
    const { app } = await buildTestApp({ servers: [server] }, deployer)

    const res = await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.teardown).toHaveBeenCalledWith("github-mcp")
  })

  it("does NOT call teardown for URL-only server", async () => {
    const deployer = mockDeployer()
    const server = makeMcpServer({
      connection: { url: "https://example.com/mcp" },
    })
    const { app } = await buildTestApp({ servers: [server] }, deployer)

    const res = await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(deployer.teardown).not.toHaveBeenCalled()
  })

  it("delete succeeds even if teardown fails", async () => {
    const deployer = mockDeployer({
      teardown: vi.fn().mockRejectedValue(new Error("k8s timeout")),
    } as Partial<McpServerDeployer>)
    const server = makeMcpServer({
      connection: { image: "ghcr.io/example:latest" },
    })
    const { app } = await buildTestApp({ servers: [server] }, deployer)

    const res = await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    // Delete still succeeds — teardown failure is best-effort
    expect(res.statusCode).toBe(200)
  })
})
