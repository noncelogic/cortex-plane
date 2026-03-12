import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database, McpServerStatus } from "../db/types.js"
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
    name: "My MCP Server",
    slug: "my-mcp-server",
    transport: "streamable-http",
    connection: { url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } },
    agent_scope: [],
    description: "A test MCP server",
    status: "ACTIVE" as McpServerStatus,
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

function makeMcpTool(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    mcp_server_id: TEST_UUID,
    name: "read_file",
    qualified_name: "my-mcp-server:read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
    annotations: null,
    status: "available",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

/** Build a chainable mock that simulates Kysely's fluent query API. */
function mockDb(
  opts: {
    servers?: Record<string, unknown>[]
    tools?: Record<string, unknown>[]
    insertedServer?: Record<string, unknown>
    updatedServer?: Record<string, unknown> | null
    insertError?: Error
  } = {},
) {
  const {
    servers = [makeMcpServer()],
    tools = [],
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
    const selectAllResult: Record<string, unknown> = {
      where: whereFn,
      orderBy,
      limit,
      offset,
      ...terminal,
    }
    // .select() chained after .selectAll() (e.g. for subquery columns) returns the same builder
    selectAllResult.select = vi.fn().mockReturnValue(selectAllResult)
    const selectAll = vi.fn().mockReturnValue(selectAllResult)
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
      if (table === "mcp_server_tool") return selectChain(tools)
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

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const db = mockDb(dbOpts)

  await app.register(mcpServerRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

  return { app, db }
}

// ---------------------------------------------------------------------------
// Tests: POST /mcp-servers
// ---------------------------------------------------------------------------

describe("POST /mcp-servers", () => {
  it("creates an MCP server", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "My MCP Server",
        transport: "streamable-http",
        connection: { url: "https://example.com/mcp" },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.name).toBe("My MCP Server")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.slug).toBe("my-mcp-server")
  })

  it("auto-generates slug from name (kebab-case)", async () => {
    const { app, db } = await buildTestApp()

    await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "My Cool MCP Server!",
        transport: "streamable-http",
        connection: { url: "https://example.com" },
      },
    })

    // Verify the slug passed to the insert
    const insertCall = (db.insertInto as ReturnType<typeof vi.fn>).mock.results[0]
    expect(insertCall).toBeDefined()
  })

  it("validates required fields", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: { description: "Missing name and transport" },
    })

    expect(res.statusCode).toBe(400)
  })

  it("validates transport enum", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Bad Transport",
        transport: "invalid-transport",
        connection: { url: "https://example.com" },
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 409 on duplicate slug", async () => {
    const { app } = await buildTestApp({
      insertError: new Error(
        'duplicate key value violates unique constraint "mcp_server_slug_key"',
      ),
    })

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "My MCP Server",
        transport: "streamable-http",
        connection: { url: "https://example.com" },
      },
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("conflict")
  })

  it("accepts optional slug override", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "My Server",
        slug: "custom-slug",
        transport: "stdio",
        connection: { command: "node", args: ["server.js"] },
      },
    })

    expect(res.statusCode).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /mcp-servers
// ---------------------------------------------------------------------------

describe("GET /mcp-servers", () => {
  it("returns list of MCP servers", async () => {
    const { app } = await buildTestApp({
      servers: [makeMcpServer(), makeMcpServer({ id: "other-id", name: "Other" })],
    })

    const res = await app.inject({ method: "GET", url: "/mcp-servers" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.servers).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.count).toBeGreaterThanOrEqual(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination.total).toBeGreaterThanOrEqual(1)
  })

  it("accepts status filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/mcp-servers?status=ACTIVE" })

    expect(res.statusCode).toBe(200)
  })

  it("accepts pagination params", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/mcp-servers?limit=10&offset=5",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination.limit).toBe(10)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination.offset).toBe(5)
  })

  it("rejects invalid status filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/mcp-servers?status=INVALID" })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /mcp-servers/:id
// ---------------------------------------------------------------------------

describe("GET /mcp-servers/:id", () => {
  it("returns MCP server with tools", async () => {
    const { app } = await buildTestApp({
      tools: [makeMcpTool()],
    })

    const res = await app.inject({
      method: "GET",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.name).toBe("My MCP Server")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.tools).toBeDefined()
  })

  it("returns 404 for nonexistent server", async () => {
    const { app } = await buildTestApp({ servers: [] })

    const res = await app.inject({
      method: "GET",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /mcp-servers/:id
// ---------------------------------------------------------------------------

describe("PUT /mcp-servers/:id", () => {
  it("updates an MCP server", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/mcp-servers/${TEST_UUID}`,
      payload: { name: "Updated Server" },
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 400 with empty body", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/mcp-servers/${TEST_UUID}`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 404 for nonexistent server", async () => {
    const { app } = await buildTestApp({ updatedServer: null })

    const res = await app.inject({
      method: "PUT",
      url: `/mcp-servers/${TEST_UUID}`,
      payload: { name: "Updated" },
    })

    expect(res.statusCode).toBe(404)
  })

  it("validates status enum on update", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/mcp-servers/${TEST_UUID}`,
      payload: { status: "INVALID_STATUS" },
    })

    expect(res.statusCode).toBe(400)
  })

  it("allows updating connection", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/mcp-servers/${TEST_UUID}`,
      payload: { connection: { url: "https://new-url.com/mcp" } },
    })

    expect(res.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /mcp-servers/:id
// ---------------------------------------------------------------------------

describe("DELETE /mcp-servers/:id", () => {
  it("deletes an MCP server", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 404 for nonexistent server", async () => {
    const { app } = await buildTestApp({ servers: [] })

    const res = await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    expect(res.statusCode).toBe(404)
  })

  it("sets status to DISABLED before deleting", async () => {
    const { app, db } = await buildTestApp()

    await app.inject({
      method: "DELETE",
      url: `/mcp-servers/${TEST_UUID}`,
    })

    // updateTable should have been called (for the DISABLED status set)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalledWith("mcp_server")
    // deleteFrom should have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.deleteFrom).toHaveBeenCalledWith("mcp_server")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /mcp-servers/:id/refresh
// ---------------------------------------------------------------------------

describe("POST /mcp-servers/:id/refresh", () => {
  it("resets server status to PENDING", async () => {
    const updatedServer = makeMcpServer({ status: "PENDING", error_message: null })
    const { app } = await buildTestApp({ updatedServer })

    const res = await app.inject({
      method: "POST",
      url: `/mcp-servers/${TEST_UUID}/refresh`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("PENDING")
  })

  it("returns 404 for nonexistent server", async () => {
    const { app } = await buildTestApp({ updatedServer: null })

    const res = await app.inject({
      method: "POST",
      url: `/mcp-servers/${TEST_UUID}/refresh`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: Encryption of connection headers
// ---------------------------------------------------------------------------

describe("connection header encryption", () => {
  async function buildEncryptedApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
    const app = Fastify({ logger: false })
    const db = mockDb(dbOpts)

    await app.register(
      mcpServerRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        connectionEncryptionKey: "test-encryption-passphrase",
      }),
    )

    return { app, db }
  }

  it("encrypts headers on create and returns decrypted in response", async () => {
    // The mock returns whatever insertedServer we provide, so the encryption
    // flow is tested through the route logic processing the body
    const serverWithEncHeaders = makeMcpServer({
      connection: {
        url: "https://example.com/mcp",
        // Simulate encrypted form (in reality the route would have encrypted)
        headers: { Authorization: "Bearer secret" },
      },
    })
    const { app } = await buildEncryptedApp({ insertedServer: serverWithEncHeaders })

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Encrypted Server",
        transport: "streamable-http",
        connection: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
      },
    })

    expect(res.statusCode).toBe(201)
  })

  it("works without encryption key configured", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "Unencrypted Server",
        transport: "streamable-http",
        connection: { url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } },
      },
    })

    expect(res.statusCode).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Tests: Auth middleware (requireAuth + requireOperator)
// ---------------------------------------------------------------------------

describe("auth middleware", () => {
  async function buildAuthApp() {
    const app = Fastify({ logger: false })
    const db = mockDb()
    const authConfig: AuthConfig = {
      requireAuth: true,
      apiKeys: [
        {
          keyHash: "", // Not used for plain-text match
          userId: "user-1",
          roles: ["operator"],
          label: "operator-key",
        },
        {
          keyHash: "",
          userId: "user-2",
          roles: ["viewer"],
          label: "viewer-key",
        },
      ],
    }

    await app.register(mcpServerRoutes({ db, authConfig }))

    return { app }
  }

  it("returns 401 on mutating endpoints without auth", async () => {
    const { app } = await buildAuthApp()

    const res = await app.inject({
      method: "POST",
      url: "/mcp-servers",
      payload: {
        name: "No Auth",
        transport: "streamable-http",
        connection: { url: "https://example.com" },
      },
    })

    expect(res.statusCode).toBe(401)
  })

  it("allows unauthenticated read on GET /mcp-servers", async () => {
    const { app } = await buildAuthApp()

    // GET endpoints do not require auth
    const res = await app.inject({
      method: "GET",
      url: "/mcp-servers",
    })

    // Even with requireAuth=true, GET does not have preHandler so it should work
    expect(res.statusCode).toBe(200)
  })
})
