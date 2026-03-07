/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentToolBindingRoutes } from "../routes/agent-tool-bindings.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const BINDING_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const SERVER_ID = "ssssssss-1111-2222-3333-444444444444"

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
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

function makeAuditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "eeeeeeee-1111-2222-3333-444444444444",
    agent_id: AGENT_ID,
    tool_ref: "mcp:slack:chat_postMessage",
    event_type: "binding_created",
    actor_user_id: "dev-user",
    job_id: null,
    details: {},
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

/**
 * Build a mock Kysely database that supports the query patterns used by
 * agentToolBindingRoutes.
 */
function mockDb(
  opts: {
    agentExists?: boolean
    existingBinding?: Record<string, unknown> | null
    insertedBinding?: Record<string, unknown>
    updatedBinding?: Record<string, unknown> | null
    bindings?: Record<string, unknown>[]
    bindingForDelete?: Record<string, unknown> | null
    serverExists?: boolean
    serverTools?: { qualified_name: string }[]
    bulkInserted?: Record<string, unknown>[]
    auditEntries?: Record<string, unknown>[]
    totalCount?: number
  } = {},
) {
  const {
    agentExists = true,
    existingBinding = null,
    insertedBinding = makeBinding(),
    updatedBinding = makeBinding(),
    bindings = [makeBinding()],
    bindingForDelete = null as Record<string, unknown> | null,
    serverExists = true,
    serverTools = [{ qualified_name: "mcp:slack:chat_postMessage" }],
    bulkInserted = [makeBinding()],
    auditEntries = [makeAuditEntry()],
    totalCount = 1,
  } = opts

  const auditInsertValues = vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue([]),
  })

  const deleteExecute = vi.fn().mockResolvedValue([])

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        const row = agentExists ? { id: AGENT_ID } : null
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(row),
            }),
          }),
        }
      }

      if (table === "agent_tool_binding") {
        // Universal chainable node — every method returns itself so
        // any Kysely chain pattern (select/selectAll/where/orderBy/
        // limit/offset/execute/executeTakeFirst/executeTakeFirstOrThrow)
        // works without needing exact call-order matching.
        const listExecute = vi.fn().mockResolvedValue(bindings)

        const chain: Record<string, ReturnType<typeof vi.fn>> = {}
        const self = () => chain
        chain.where = vi.fn().mockImplementation(self)
        chain.orderBy = vi.fn().mockImplementation(self)
        chain.limit = vi.fn().mockImplementation(self)
        chain.offset = vi.fn().mockImplementation(self)
        chain.execute = listExecute
        chain.executeTakeFirst = vi.fn().mockResolvedValue(existingBinding ?? bindingForDelete)
        chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue({ total: totalCount })

        return {
          select: vi.fn().mockReturnValue(chain),
          selectAll: vi.fn().mockReturnValue(chain),
        }
      }

      if (table === "mcp_server") {
        const row = serverExists ? { id: SERVER_ID } : null
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(row),
            }),
          }),
        }
      }

      if (table === "mcp_server_tool") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue(serverTools),
            }),
          }),
        }
      }

      if (table === "capability_audit_log") {
        const auditExecute = vi.fn().mockResolvedValue(auditEntries)
        const auditOffset = vi.fn().mockReturnValue({ execute: auditExecute })
        const auditLimit = vi.fn().mockReturnValue({ offset: auditOffset })
        const auditOrderBy = vi.fn().mockReturnValue({ limit: auditLimit })

        const auditWhere: ReturnType<typeof vi.fn> = vi.fn()
        auditWhere.mockReturnValue({
          where: auditWhere,
          orderBy: auditOrderBy,
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ total: totalCount }),
        })
        const auditSelectAll = vi.fn().mockReturnValue({ where: auditWhere })

        const auditCountWhere: ReturnType<typeof vi.fn> = vi.fn()
        auditCountWhere.mockReturnValue({
          where: auditCountWhere,
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ total: totalCount }),
        })

        return {
          selectAll: auditSelectAll,
          select: vi.fn().mockReturnValue({ where: auditCountWhere }),
        }
      }

      // Fallback
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_tool_binding") {
        return {
          values: vi.fn().mockReturnValue({
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue(insertedBinding),
            }),
            onConflict: vi.fn().mockReturnValue({
              returningAll: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue(bulkInserted),
              }),
            }),
          }),
        }
      }

      if (table === "capability_audit_log") {
        return { values: auditInsertValues }
      }

      return {
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue([]),
        }),
      }
    }),

    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(updatedBinding),
            }),
          }),
        }),
      }),
    }),

    deleteFrom: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: deleteExecute,
        }),
      }),
    }),

    fn: {
      countAll: vi.fn().mockReturnValue({
        as: vi.fn().mockReturnValue("count_expr"),
      }),
    },
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
      payload: {
        toolRef: "mcp:slack:chat_postMessage",
        approvalPolicy: "auto",
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe(BINDING_ID)
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.toolRef).toBe("mcp:slack:chat_postMessage")
    expect(body.approvalPolicy).toBe("auto")

    // Verify audit log was written
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: { toolRef: "web_search" },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Agent")
  })

  it("returns 409 on duplicate (agentId, toolRef)", async () => {
    const { app } = await buildTestApp({
      existingBinding: makeBinding(),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: { toolRef: "mcp:slack:chat_postMessage" },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.message).toContain("already exists")
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

  it("accepts optional rateLimit and dataScope", async () => {
    const binding = makeBinding({
      rate_limit: { maxCalls: 100, windowSeconds: 3600 },
      data_scope: { channels: ["#general"] },
    })
    const { app } = await buildTestApp({ insertedBinding: binding })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings`,
      payload: {
        toolRef: "mcp:slack:chat_postMessage",
        rateLimit: { maxCalls: 100, windowSeconds: 3600 },
        dataScope: { channels: ["#general"] },
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.rateLimit).toEqual({ maxCalls: 100, windowSeconds: 3600 })
    expect(body.dataScope).toEqual({ channels: ["#general"] })
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
    const body = res.json()
    expect(body.bindings).toBeDefined()
    expect(Array.isArray(body.bindings)).toBe(true)
    expect(typeof body.total).toBe("number")
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/tool-bindings`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /agents/:agentId/tool-bindings/:bindingId
// ---------------------------------------------------------------------------

describe("PUT /agents/:agentId/tool-bindings/:bindingId", () => {
  it("updates a binding", async () => {
    const updated = makeBinding({
      approval_policy: "always_approve",
      enabled: false,
    })
    const { app } = await buildTestApp({ updatedBinding: updated })

    const res = await app.inject({
      method: "PUT",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
      payload: {
        approvalPolicy: "always_approve",
        enabled: false,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.approvalPolicy).toBe("always_approve")
    expect(body.enabled).toBe(false)
  })

  it("returns 404 when binding does not exist", async () => {
    const { app } = await buildTestApp({ updatedBinding: null })

    const res = await app.inject({
      method: "PUT",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
      payload: { enabled: false },
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 400 when no fields provided", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("No fields")
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:agentId/tool-bindings/:bindingId
// ---------------------------------------------------------------------------

describe("DELETE /agents/:agentId/tool-bindings/:bindingId", () => {
  it("removes a binding and writes audit log", async () => {
    const { app, auditInsertValues } = await buildTestApp({
      bindingForDelete: makeBinding(),
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
    })

    expect(res.statusCode).toBe(204)
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when binding does not exist", async () => {
    const { app } = await buildTestApp({ bindingForDelete: null })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/tool-bindings/${BINDING_ID}`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/tool-bindings/bulk
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/tool-bindings/bulk", () => {
  it("bulk-creates bindings from MCP server", async () => {
    const { app, auditInsertValues } = await buildTestApp({
      bulkInserted: [makeBinding()],
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: {
        mcpServerId: SERVER_ID,
        approvalPolicy: "auto",
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.created).toBe(1)
    expect(body.bindings).toHaveLength(1)
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: SERVER_ID },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Agent")
  })

  it("returns 404 when MCP server does not exist", async () => {
    const { app } = await buildTestApp({ serverExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: { mcpServerId: SERVER_ID },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("MCP server")
  })

  it("accepts explicit toolRefs list", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/tool-bindings/bulk`,
      payload: {
        mcpServerId: SERVER_ID,
        toolRefs: ["mcp:slack:chat_postMessage"],
      },
    })

    expect(res.statusCode).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/effective-tools
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/effective-tools", () => {
  it("returns effective tools for an agent", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/effective-tools`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tools).toBeDefined()
    expect(Array.isArray(body.tools)).toBe(true)
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
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/capability-audit
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/capability-audit", () => {
  it("returns audit log entries", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/capability-audit`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.entries).toBeDefined()
    expect(Array.isArray(body.entries)).toBe(true)
    expect(typeof body.total).toBe("number")
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/capability-audit`,
    })

    expect(res.statusCode).toBe(404)
  })
})
