import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { sessionRoutes } from "../routes/sessions.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    user_account_id: "user-111",
    channel_id: "telegram:chat-42",
    status: "active",
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1111-2222-3333-4444",
    session_id: "aaaaaaaa-1111-2222-3333-444444444444",
    role: "user",
    content: "Hello",
    created_at: new Date(),
    metadata: {},
    ...overrides,
  }
}

/** Build a chainable mock that simulates Kysely's fluent query API. */
function mockDb(
  opts: {
    agent?: Record<string, unknown> | null
    sessions?: Record<string, unknown>[]
    session?: Record<string, unknown> | null
    messages?: Record<string, unknown>[]
  } = {},
) {
  const {
    agent = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    sessions = [makeSession()],
    session = makeSession(),
    messages = [makeMessage()],
  } = opts

  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "agent") {
      const executeTakeFirst = vi.fn().mockResolvedValue(agent)
      const terminal = { executeTakeFirst }
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, ...terminal })
      const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
      return { select, selectAll: select }
    }

    if (table === "session") {
      const execute = vi.fn().mockResolvedValue(sessions)
      const executeTakeFirst = vi.fn().mockResolvedValue(session)
      const offsetFn = vi.fn().mockReturnValue({ execute })
      const limitFn = vi.fn().mockReturnValue({ execute, offset: offsetFn })
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({
        where: whereFn,
        orderBy: orderByFn,
        limit: limitFn,
        execute,
        executeTakeFirst,
      })
      const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
      const selectAll = vi.fn().mockReturnValue({
        where: whereFn,
        orderBy: orderByFn,
        execute,
      })
      return { select, selectAll }
    }

    if (table === "session_message") {
      const execute = vi.fn().mockResolvedValue(messages)
      const offsetFn = vi.fn().mockReturnValue({ execute })
      const limitFn = vi.fn().mockReturnValue({ execute, offset: offsetFn })
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn, limit: limitFn, execute })
      const selectAll = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn, execute })
      return { select: selectAll, selectAll }
    }

    // Fallback
    const executeTakeFirst = vi.fn().mockResolvedValue(null)
    const terminal = { executeTakeFirst }
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, ...terminal })
    const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
    return { select, selectAll: select }
  })

  const deleteFromFn = vi.fn().mockImplementation(() => {
    const execute = vi.fn().mockResolvedValue({ numDeletedRows: BigInt(1) })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, execute })
    return { where: whereFn, execute }
  })

  const updateTableFn = vi.fn().mockImplementation(() => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, execute })
    const set = vi.fn().mockReturnValue({ where: whereFn, execute })
    return { set }
  })

  return {
    selectFrom: selectFromFn,
    insertInto: vi.fn(),
    updateTable: updateTableFn,
    deleteFrom: deleteFromFn,
  } as unknown as Kysely<Database>
}

async function buildApp(db: Kysely<Database>) {
  const app = Fastify()
  await app.register(
    sessionRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
    }),
  )
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /agents/:id/sessions", () => {
  it("returns sessions for an agent", async () => {
    const db = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/sessions`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.sessions).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.count).toBe(1)
  })

  it("returns 404 when agent not found", async () => {
    const db = mockDb({ agent: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-000000000000/sessions`,
    })

    expect(res.statusCode).toBe(404)
  })
})

describe("GET /sessions/:id/messages", () => {
  it("returns messages for a session", async () => {
    const db = mockDb({
      messages: [
        makeMessage({ role: "user", content: "Hello" }),
        makeMessage({ id: "msg-2", role: "assistant", content: "Hi!" }),
      ],
    })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/sessions/aaaaaaaa-1111-2222-3333-444444444444/messages`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.messages).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.count).toBe(2)
  })

  it("returns 404 when session not found", async () => {
    const db = mockDb({ session: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/sessions/aaaaaaaa-1111-2222-3333-000000000000/messages`,
    })

    expect(res.statusCode).toBe(404)
  })
})

describe("DELETE /sessions/:id", () => {
  it("clears session messages and marks session as ended", async () => {
    const db = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/aaaaaaaa-1111-2222-3333-444444444444`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("ended")

    // Should have deleted session messages
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.deleteFrom).toHaveBeenCalledWith("session_message")
    // Should have updated session status
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalledWith("session")
  })

  it("returns 404 when session not found", async () => {
    const db = mockDb({ session: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/aaaaaaaa-1111-2222-3333-000000000000`,
    })

    expect(res.statusCode).toBe(404)
  })
})
