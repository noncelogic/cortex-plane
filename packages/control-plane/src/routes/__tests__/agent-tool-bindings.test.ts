import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../../db/types.js"
import type { AuthConfig } from "../../middleware/types.js"
import { agentToolBindingRoutes } from "../agent-tool-bindings.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const BINDING_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const MCP_SERVER_ID = "ssssssss-1111-2222-3333-444444444444"

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: BINDING_ID,
    agent_id: AGENT_ID,
    tool_ref: "mcp:slack:chat_postMessage",
    approval_policy: "auto",
    approval_condition: null,
    rate_limit: null,
    cost_budget: null,
    data_scope: null,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

/**
 * Build a mock Kysely database that supports the query patterns used by
 * agentToolBindingRoutes. Each table handler returns chainable methods.
 */
function mockDb(
  opts: {
    agentExists?: boolean
    existingBinding?: Record<string, unknown> | null
    insertedBinding?: Record<string, unknown>
    bindings?: Record<string, unknown>[]
    mcpServerExists?: boolean
    mcpServerTools?: Record<string, unknown>[]
    existingToolRefs?: string[]
    bulkInsertedBindings?: Record<string, unknown>[]
    updatedBinding?: Record<string, unknown>
    mcpToolsMeta?: Record<string, unknown>[]
  } = {},
) {
  const {
    agentExists = true,
    existingBinding = null,
    insertedBinding = makeBinding(),
    bindings = [makeBinding()],
    mcpServerExists = true,
    mcpServerTools = [{ qualified_name: "mcp:slack:chat_postMessage" }],
    existingToolRefs = [],
    bulkInsertedBindings = [makeBinding()],
    updatedBinding = makeBinding(),
    mcpToolsMeta = [],
  } = opts

  // Track insertInto calls for audit log verification
  const auditInsertValues = vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue([]),
  })

  // Track deleteFrom calls
  const deleteExecute = vi.fn().mockResolvedValue([])
  const deleteWhere2 = vi.fn().mockReturnValue({ execute: deleteExecute })
  const deleteWhere1 = vi.fn().mockReturnValue({ where: deleteWhere2 })

  /**
   * Creates a universal chain object that supports all Kysely query methods.
   * Each method returns the same chain, so any call order works.
   */
  function makeChain(result: unknown, resolveMode: "first" | "all" = "first") {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    const executeTakeFirst = vi.fn().mockResolvedValue(result)
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
    const execute = vi.fn().mockResolvedValue(resolveMode === "all" ? result : [result])

    chain.where = vi.fn().mockImplementation(() => chain)
    chain.orderBy = vi.fn().mockImplementation(() => chain)
    chain.select = vi.fn().mockImplementation(() => chain)
    chain.selectAll = vi.fn().mockImplementation(() => chain)
    chain.innerJoin = vi.fn().mockImplementation(() => chain)
    chain.executeTakeFirst = executeTakeFirst
    chain.executeTakeFirstOrThrow = executeTakeFirstOrThrow
    chain.execute = execute
    return chain
  }

  // Track which selectFrom call count per table for disambiguation
  const selectFromCounts: Record<string, number> = {}

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      selectFromCounts[table] = (selectFromCounts[table] ?? 0) + 1
      const count = selectFromCounts[table]

      if (table === "agent") {
        return makeChain(agentExists ? { id: AGENT_ID } : null)
      }

      if (table === "mcp_server") {
        return makeChain(mcpServerExists ? { id: MCP_SERVER_ID, slug: "slack" } : null)
      }

      if (table === "mcp_server_tool") {
        // For bulk: returns list of tools. For effective-tools: join chain
        return makeChain(mcpToolsMeta.length > 0 ? mcpToolsMeta : mcpServerTools, "all")
      }

      if (table === "agent_tool_binding") {
        if (count === 1) {
          // 1st call: POST=duplicate check, GET=list, PUT/DELETE=single lookup, effective-tools=list enabled
          // We need a chain that works for ALL patterns:
          // - select("id").where().where().executeTakeFirst() — duplicate check
          // - selectAll().where().orderBy().execute() — list
          // - selectAll().where().where().executeTakeFirst() — single lookup
          // - selectAll().where().where().orderBy().execute() — effective-tools list
          const chain = makeChain(existingBinding)
          // Override execute to return bindings array for list/effective routes
          chain.execute = vi.fn().mockResolvedValue(bindings)
          return chain
        }
        // 2nd call: for bulk, this is the existing tool refs check
        return makeChain(
          existingToolRefs.map((r) => ({ tool_ref: r })),
          "all",
        )
      }

      return makeChain(null)
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_tool_binding") {
        const execute = vi.fn().mockResolvedValue(bulkInsertedBindings)
        const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(insertedBinding)
        const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow, execute })
        const values = vi.fn().mockReturnValue({ returningAll })
        return { values }
      }

      if (table === "capability_audit_log") {
        return { values: auditInsertValues }
      }

      return {
        values: vi.fn().mockReturnValue({
          returningAll: vi.fn().mockReturnValue({
            executeTakeFirstOrThrow: vi.fn().mockResolvedValue({}),
          }),
          execute: vi.fn().mockResolvedValue([]),
        }),
      }
    }),

    updateTable: vi.fn().mockImplementation(() => {
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(updatedBinding)
      const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, returningAll })
      const set = vi.fn().mockReturnValue({ where: whereFn })
      return { set }
    }),

    deleteFrom: vi.fn().mockReturnValue({ where: deleteWhere1 }),
  } as unknown as Kysely<Database>

  return { db, auditInsertValues, deleteExecute }
}

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const { db, auditInsertValues, deleteExecute } = mockDb(dbOpts)

  await app.register(agentToolBindingRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

  return { app, db, auditInsertValues, deleteExecute }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/tool-bindings
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/tool-bindings", () => {
  it("creates a tool binding", async () => {
    const { app, auditInsertValues } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: { toolRef: "mcp:slack:chat_postMessage" },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding.agentId).toBe(AGENT_ID)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding.toolRef).toBe("mcp:slack:chat_postMessage")

    // Verify audit log was written
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: { toolRef: "mcp:slack:chat_postMessage" },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })

  it("returns 409 on duplicate binding", async () => {
    const { app } = await buildTestApp({
      existingBinding: makeBinding(),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: { toolRef: "mcp:slack:chat_postMessage" },
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("already bound")
  })

  it("validates required toolRef field", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("accepts optional policy fields", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: {
        toolRef: "web_search",
        approvalPolicy: "always_approve",
        rateLimit: { maxCalls: 100, windowSeconds: 3600 },
        dataScope: { readOnly: true },
      },
    })

    expect(res.statusCode).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/tool-bindings
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/tool-bindings", () => {
  it("returns list of bindings", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/tool-bindings`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bindings).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(Array.isArray(body.bindings)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.total).toBeDefined()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/tool-bindings`,
    })

    expect(res.statusCode).toBe(404)
  })

  it("supports enabled filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/tool-bindings?enabled=true`,
    })

    expect(res.statusCode).toBe(200)
  })

  it("supports category filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/tool-bindings?category=communication`,
    })

    expect(res.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /agents/:agentId/tool-bindings/:bindingId
// ---------------------------------------------------------------------------

describe("PUT /agents/:agentId/tool-bindings/:bindingId", () => {
  it("updates a tool binding", async () => {
    const updated = makeBinding({ approval_policy: "always_approve", enabled: false })
    const { app } = await buildTestApp({
      existingBinding: makeBinding(),
      updatedBinding: updated,
    })

    const res = await app.inject({
      method: "PUT",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
      payload: { approvalPolicy: "always_approve", enabled: false },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding).toBeDefined()
  })

  it("returns 404 when binding does not exist", async () => {
    const { app } = await buildTestApp({
      existingBinding: null,
    })

    const res = await app.inject({
      method: "PUT",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
      payload: { enabled: false },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Binding")
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:agentId/tool-bindings/:bindingId
// ---------------------------------------------------------------------------

describe("DELETE /agents/:agentId/tool-bindings/:bindingId", () => {
  it("removes a tool binding and returns 204", async () => {
    const { app, auditInsertValues } = await buildTestApp({
      existingBinding: makeBinding(),
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
    })

    expect(res.statusCode).toBe(204)

    // Verify audit log was written
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when binding does not exist", async () => {
    const { app } = await buildTestApp({
      existingBinding: null,
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Binding")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/tool-bindings/bulk
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/tool-bindings/bulk", () => {
  it("bulk-creates bindings from MCP server", async () => {
    const binding1 = makeBinding({ tool_ref: "mcp:slack:chat_postMessage" })
    const { app, auditInsertValues } = await buildTestApp({
      bindings: [],
      bulkInsertedBindings: [binding1],
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: MCP_SERVER_ID },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.created).toBeGreaterThanOrEqual(0)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bindings).toBeDefined()

    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: MCP_SERVER_ID },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })

  it("returns 404 when MCP server does not exist", async () => {
    const { app } = await buildTestApp({ mcpServerExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: MCP_SERVER_ID },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("MCP server")
  })

  it("skips duplicate bindings during bulk create", async () => {
    const { app } = await buildTestApp({
      existingToolRefs: ["mcp:slack:chat_postMessage"],
      mcpServerTools: [{ qualified_name: "mcp:slack:chat_postMessage" }],
      bulkInsertedBindings: [],
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: MCP_SERVER_ID },
    })

    // Should succeed with 0 created (all duplicates)
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().created).toBe(0)
  })

  it("validates required mcpServerId field", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/effective-tools
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/effective-tools", () => {
  it("returns effective tool list", async () => {
    const { app } = await buildTestApp({
      bindings: [makeBinding({ tool_ref: "web_search" })],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/effective-tools`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.tools).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.assembledAt).toBeDefined()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/effective-tools`,
    })

    expect(res.statusCode).toBe(404)
  })

  it("includes MCP tool metadata when available", async () => {
    const { app } = await buildTestApp({
      bindings: [makeBinding({ tool_ref: "mcp:slack:chat_postMessage" })],
      mcpToolsMeta: [
        {
          qualified_name: "mcp:slack:chat_postMessage",
          name: "chat_postMessage",
          description: "Post a message to Slack",
          input_schema: { type: "object" },
          serverStatus: "ACTIVE",
        },
      ],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/effective-tools`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.tools).toBeDefined()
  })
})
