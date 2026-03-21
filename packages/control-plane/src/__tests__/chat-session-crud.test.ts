/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Chat session CRUD integration tests (#492).
 *
 * Exercises the full create → list → send → delete lifecycle through
 * Fastify route injection with mocked DB and preflight dependencies.
 *
 * Test cases:
 * 1. Create session → appears in list
 * 2. Send message → stored and returned in history
 * 3. Delete session → messages cleared, status ended
 * 4. Delete active session → no active sessions remain for agent
 * 5. Delete non-existent session → 404
 * 6. Preflight: quarantined agent blocks send (409)
 * 7. Preflight: no LLM credential blocks send (422)
 */

import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { chatRoutes } from "../routes/chat.js"
import { sessionRoutes } from "../routes/sessions.js"

// ---------------------------------------------------------------------------
// Mock preflight — default: ok, overridden per-test
// ---------------------------------------------------------------------------

const mockRunPreflight = vi.hoisted(() => vi.fn())
const mockMapJobErrorToUserMessage = vi.hoisted(() => vi.fn())

vi.mock("../channels/preflight.js", () => ({
  runPreflight: mockRunPreflight,
  mapJobErrorToUserMessage: mockMapJobErrorToUserMessage,
}))

// Mock loadConversationHistory + watchJobCompletion (chat route imports them)
const mockLoadConversationHistory = vi.hoisted(() => vi.fn())
const mockWatchJobCompletion = vi.hoisted(() => vi.fn())

vi.mock("../channels/message-dispatch.js", () => ({
  loadConversationHistory: mockLoadConversationHistory,
  watchJobCompletion: mockWatchJobCompletion,
}))

// Mock ensureUuid (used by chat route for principal userId)
vi.mock("../util/name-uuid.js", () => ({
  ensureUuid: vi.fn((v: string) => v),
}))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ACCOUNT_ID = "uuuuuuuu-1111-2222-3333-444444444444"

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    agent_id: AGENT_ID,
    user_account_id: USER_ACCOUNT_ID,
    channel_id: "rest:api",
    status: "active",
    metadata: {},
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_cost_usd: 0,
    created_at: new Date("2026-03-09T00:00:00Z"),
    updated_at: new Date("2026-03-09T00:00:00Z"),
    ...overrides,
  }
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1111-2222-3333-4444",
    session_id: SESSION_ID,
    role: "user",
    content: "Hello",
    created_at: new Date("2026-03-09T00:00:00Z"),
    metadata: {},
    ...overrides,
  }
}

/**
 * Build a mock Kysely DB that supports both session routes and chat routes.
 *
 * Tracks inserts into session_message and session for assertion.
 */
function mockDb(
  opts: {
    agent?: Record<string, unknown> | null
    sessions?: Record<string, unknown>[]
    session?: Record<string, unknown> | null
    messages?: Record<string, unknown>[]
    userAccount?: Record<string, unknown> | null
    job?: Record<string, unknown>
  } = {},
) {
  const {
    agent = { id: AGENT_ID, status: "ACTIVE" },
    sessions = [makeSession()],
    session = makeSession(),
    messages = [makeMessage()],
    userAccount = { id: USER_ACCOUNT_ID },
    job = { id: "job-1111" },
  } = opts

  const sessionMessageInserts: Array<Record<string, unknown>> = []
  const sessionInserts: Array<Record<string, unknown>> = []
  const deleteFromCalls: string[] = []

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
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(session ?? { id: "new-session-id" })
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
        executeTakeFirstOrThrow,
        offset: offsetFn,
      })
      const select = vi
        .fn()
        .mockReturnValue({ where: whereFn, executeTakeFirst, executeTakeFirstOrThrow })
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

    if (table === "user_account") {
      const executeTakeFirst = vi.fn().mockResolvedValue(userAccount)
      const terminal = { executeTakeFirst }
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, ...terminal })
      const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
      return { select, selectAll: select }
    }

    // Fallback (job table, etc.)
    const executeTakeFirst = vi.fn().mockResolvedValue(null)
    const terminal = { executeTakeFirst }
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, ...terminal })
    const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
    return { select, selectAll: select }
  })

  const insertIntoFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session_message") {
      const execute = vi.fn().mockResolvedValue(undefined)
      const values = vi.fn().mockImplementation((val: Record<string, unknown>) => {
        sessionMessageInserts.push(val)
        return {
          execute,
          returning: vi
            .fn()
            .mockReturnValue({ executeTakeFirstOrThrow: vi.fn().mockResolvedValue(val) }),
        }
      })
      return { values }
    }

    if (table === "session") {
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(session ?? { id: "new-session-id" })
      const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
      const values = vi.fn().mockImplementation((val: Record<string, unknown>) => {
        sessionInserts.push(val)
        return { returning }
      })
      return { values }
    }

    if (table === "user_account") {
      const execute = vi.fn().mockResolvedValue(undefined)
      const values = vi.fn().mockReturnValue({ execute })
      return { values }
    }

    // job insert
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(job)
    const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
    const values = vi.fn().mockReturnValue({ returning })
    return { values }
  })

  const deleteFromFn = vi.fn().mockImplementation((table: string) => {
    deleteFromCalls.push(table)
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

  const db = {
    selectFrom: selectFromFn,
    insertInto: insertIntoFn,
    updateTable: updateTableFn,
    deleteFrom: deleteFromFn,
  } as unknown as Kysely<Database>

  return { db, sessionMessageInserts, sessionInserts, deleteFromCalls, deleteFromFn }
}

/** Build a Fastify app with both chat + session routes registered. */
async function buildApp(db: Kysely<Database>, enqueueJob = vi.fn().mockResolvedValue(undefined)) {
  const app = Fastify({ logger: false })
  await app.register(
    chatRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
      enqueueJob,
    }),
  )
  await app.register(
    sessionRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
    }),
  )
  return app
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRunPreflight.mockResolvedValue({ ok: true })
  mockMapJobErrorToUserMessage.mockReturnValue(
    "Something went wrong processing your message. Please try again.",
  )
  mockLoadConversationHistory.mockResolvedValue([])
  mockWatchJobCompletion.mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Create session → appears in list
// ---------------------------------------------------------------------------

describe("Create session → appears in list", () => {
  it("sending a chat message creates a session that appears in GET /agents/:id/sessions", async () => {
    const createdSession = makeSession()
    const { db, sessionMessageInserts } = mockDb({ session: createdSession })
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    // Send a chat message (creates/reuses session)
    const chatRes = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello, agent!" },
    })

    expect(chatRes.statusCode).toBe(202)
    expect(chatRes.json().session_id).toBe(SESSION_ID)
    expect(chatRes.json().status).toBe("SCHEDULED")

    // Verify user message was stored
    expect(sessionMessageInserts).toContainEqual(
      expect.objectContaining({
        session_id: SESSION_ID,
        role: "user",
        content: "Hello, agent!",
      }),
    )

    // List sessions — the session should appear
    const listRes = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/sessions`,
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().sessions).toHaveLength(1)
    expect(listRes.json().sessions[0].id).toBe(SESSION_ID)
    expect(listRes.json().sessions[0].status).toBe("active")
  })
})

// ---------------------------------------------------------------------------
// 2. Send message → stored and returned in history
// ---------------------------------------------------------------------------

describe("Send message → stored and returned in history", () => {
  it("user message is stored via chat route and retrievable via GET /sessions/:id/messages", async () => {
    const userMsg = makeMessage({ role: "user", content: "What is 2+2?" })
    const assistantMsg = makeMessage({
      id: "msg-2222",
      role: "assistant",
      content: "4",
      created_at: new Date("2026-03-09T00:01:00Z"),
    })

    const { db, sessionMessageInserts } = mockDb({
      messages: [userMsg, assistantMsg],
    })
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    // Send chat message
    const chatRes = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "What is 2+2?" },
    })

    expect(chatRes.statusCode).toBe(202)
    expect(sessionMessageInserts[0]).toEqual(
      expect.objectContaining({
        session_id: SESSION_ID,
        role: "user",
        content: "What is 2+2?",
      }),
    )

    // Retrieve message history
    const historyRes = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}/messages`,
    })

    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.json().messages).toHaveLength(2)
    expect(historyRes.json().count).toBe(2)
    expect(historyRes.json().messages[0].role).toBe("user")
    expect(historyRes.json().messages[0].content).toBe("What is 2+2?")
    expect(historyRes.json().messages[1].role).toBe("assistant")
    expect(historyRes.json().messages[1].content).toBe("4")
  })

  it("loads conversation history before creating job", async () => {
    const priorHistory = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]
    mockLoadConversationHistory.mockResolvedValue(priorHistory)

    const { db } = mockDb()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Follow-up question" },
    })

    expect(mockLoadConversationHistory).toHaveBeenCalledWith(expect.anything(), SESSION_ID)
  })
})

// ---------------------------------------------------------------------------
// 3. Delete session → removed, messages cleared, status ended
// ---------------------------------------------------------------------------

describe("Delete session → messages cleared, status ended", () => {
  it("DELETE /sessions/:id clears messages and sets status to ended", async () => {
    const { db, deleteFromFn } = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(SESSION_ID)
    expect(res.json().status).toBe("ended")
    expect(res.json().action).toBe("cleared")

    // Verify session_message rows were deleted
    expect(deleteFromFn).toHaveBeenCalledWith("session_message")

    // Verify session status was updated
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalledWith("session")
  })
})

// ---------------------------------------------------------------------------
// 4. Delete active session → no active sessions remain for agent
// ---------------------------------------------------------------------------

describe("Delete active session → activeSessionId cleared", () => {
  it("after deleting an active session, listing returns no active sessions", async () => {
    const activeSession = makeSession({ status: "active" })

    // Shared flag — flipped by deleteFrom, checked by selectFrom("session")
    let sessionDeleted = false

    const selectFromFn = vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        const executeTakeFirst = vi.fn().mockResolvedValue({ id: AGENT_ID })
        const whereFn: ReturnType<typeof vi.fn> = vi.fn()
        whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
        const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
        return { select, selectAll: select }
      }

      if (table === "session") {
        const executeTakeFirst = vi
          .fn()
          .mockImplementation(() => (sessionDeleted ? null : activeSession))
        const execute = vi.fn().mockImplementation(() => (sessionDeleted ? [] : [activeSession]))
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
          offset: offsetFn,
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
        const execute = vi.fn().mockResolvedValue([])
        const offsetFn = vi.fn().mockReturnValue({ execute })
        const limitFn = vi.fn().mockReturnValue({ execute, offset: offsetFn })
        const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
        const whereFn: ReturnType<typeof vi.fn> = vi.fn()
        whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn, limit: limitFn, execute })
        const selectAll = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn, execute })
        return { select: selectAll, selectAll }
      }

      const executeTakeFirst = vi.fn().mockResolvedValue(null)
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
      const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
      return { select, selectAll: select }
    })

    const deleteFromFn = vi.fn().mockImplementation(() => {
      sessionDeleted = true
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

    const db = {
      selectFrom: selectFromFn,
      insertInto: vi.fn(),
      updateTable: updateTableFn,
      deleteFrom: deleteFromFn,
    } as unknown as Kysely<Database>

    const app = Fastify({ logger: false })
    await app.register(sessionRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

    // Pre-condition: session exists
    const listBefore = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/sessions`,
    })
    expect(listBefore.statusCode).toBe(200)
    expect(listBefore.json().sessions).toHaveLength(1)

    // Delete the active session
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}`,
    })
    expect(deleteRes.statusCode).toBe(200)
    expect(deleteRes.json().status).toBe("ended")

    // Post-condition: no active sessions remain
    const listAfter = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/sessions`,
    })
    expect(listAfter.statusCode).toBe(200)
    expect(listAfter.json().sessions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Delete non-existent session → 404
// ---------------------------------------------------------------------------

describe("Delete non-existent session → 404", () => {
  it("returns 404 when deleting a session that does not exist", async () => {
    const { db } = mockDb({ session: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/aaaaaaaa-0000-0000-0000-000000000000`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
    expect(res.json().message).toBe("Session not found")
  })

  it("returns 404 when fetching messages for a non-existent session", async () => {
    const { db } = mockDb({ session: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/sessions/aaaaaaaa-0000-0000-0000-000000000000/messages`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })
})

// ---------------------------------------------------------------------------
// 6. Preflight: quarantined agent blocks send with actionable error
// ---------------------------------------------------------------------------

describe("Preflight: quarantined agent blocks send", () => {
  it("returns 409 with actionable message when agent is quarantined", async () => {
    mockRunPreflight.mockResolvedValue({
      ok: false,
      code: "agent_not_active",
      userMessage:
        "This agent is temporarily quarantined due to repeated failures. " +
        "An operator can reset it from the agent dashboard.",
    })

    const { db } = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("agent_not_active")
    expect(res.json().message).toContain("quarantined")
    expect(res.json().message).toContain("operator")
  })

  it("returns 409 with actionable message when agent is disabled", async () => {
    mockRunPreflight.mockResolvedValue({
      ok: false,
      code: "agent_not_active",
      userMessage:
        "This agent has been disabled by an operator. " +
        "Contact your administrator to re-enable it.",
    })

    const { db } = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("agent_not_active")
    expect(res.json().message).toContain("disabled")
  })
})

// ---------------------------------------------------------------------------
// 7. Preflight: no LLM credential blocks send with actionable error
// ---------------------------------------------------------------------------

describe("Preflight: no LLM credential blocks send", () => {
  it("returns 422 with actionable message when no LLM credential is configured", async () => {
    mockRunPreflight.mockResolvedValue({
      ok: false,
      code: "no_llm_credential",
      userMessage:
        "This agent does not have an LLM API key configured. " +
        "An operator needs to bind an LLM credential in the agent settings.",
    })

    const { db } = mockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe("no_llm_credential")
    expect(res.json().message).toContain("LLM API key")
    expect(res.json().message).toContain("operator")
  })
})

// ---------------------------------------------------------------------------
// Dashboard reflects session state changes
// ---------------------------------------------------------------------------

describe("Dashboard reflects session state changes", () => {
  it("session list reflects creation via chat", async () => {
    const newSession = makeSession({ status: "active" })
    const { db } = mockDb({ sessions: [newSession], session: newSession })
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    // Send message to create/reuse session
    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Dashboard test" },
    })

    // Dashboard list sessions
    const listRes = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/sessions`,
    })

    expect(listRes.statusCode).toBe(200)
    expect(listRes.json().sessions).toHaveLength(1)
    expect(listRes.json().sessions[0].status).toBe("active")
  })

  it("agent not found returns 404 on session list", async () => {
    const { db } = mockDb({ agent: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-0000-0000-0000-000000000000/sessions`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("chat route returns job_id and session_id for async polling", async () => {
    const { db } = mockDb({ job: { id: "job-async-1" } })
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Async test" },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json().job_id).toBe("job-async-1")
    expect(res.json().session_id).toBe(SESSION_ID)
    expect(res.json().status).toBe("SCHEDULED")
    expect(enqueueJob).toHaveBeenCalledWith("job-async-1")
  })
})

// ---------------------------------------------------------------------------
// Sync wait: error detail propagation (#554)
// ---------------------------------------------------------------------------

describe("Sync wait propagates job error details (#554)", () => {
  it("returns error message from job error column on FAILED job", async () => {
    const jobError = { category: "LLM_ERROR", message: "Rate limit exceeded" }

    // Make watchJobCompletion invoke the callback immediately with FAILED status
    mockWatchJobCompletion.mockImplementation(
      (_db: unknown, _jobId: string, cb: (result: unknown, status: string) => Promise<void>) => {
        void cb(null, "FAILED")
      },
    )

    // Build db where job-table selectFrom returns the error column
    const { db: baseDb } = mockDb({ job: { id: "job-fail-1" } })
    const { db: fallbackDb } = mockDb({ job: { id: "job-fail-1" } })
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const baseSelectFrom = vi.mocked(baseDb.selectFrom)
    baseSelectFrom.mockImplementation((table: string) => {
      if (table === "job") {
        const executeTakeFirst = vi.fn().mockResolvedValue({ error: jobError })
        const whereFn: ReturnType<typeof vi.fn> = vi.fn()
        whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
        const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
        return { select } as never
      }
      return (fallbackDb.selectFrom as ReturnType<typeof vi.fn>)(table) as never
    })
    const db = baseDb

    mockMapJobErrorToUserMessage.mockReturnValue("Rate limit exceeded")
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat?wait=true&timeout=5000`,
      payload: { text: "Fail test" },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    expect(body.status).toBe("FAILED")
    expect(body.error).toBeDefined()
    expect(body.error.message).toBe("Rate limit exceeded")
    expect(body.error.code).toBe("job_failed")
  })

  it("returns fallback error message when error column fetch fails", async () => {
    // Make watchJobCompletion invoke the callback immediately with FAILED status
    mockWatchJobCompletion.mockImplementation(
      (_db: unknown, _jobId: string, cb: (result: unknown, status: string) => Promise<void>) => {
        void cb(null, "FAILED")
      },
    )

    // Build db where job-table selectFrom rejects (simulates connection failure)
    const { db: baseDb } = mockDb({ job: { id: "job-fail-2" } })
    const { db: fallbackDb } = mockDb({ job: { id: "job-fail-2" } })
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const baseSelectFrom = vi.mocked(baseDb.selectFrom)
    baseSelectFrom.mockImplementation((table: string) => {
      if (table === "job") {
        const executeTakeFirst = vi.fn().mockRejectedValue(new Error("connection lost"))
        const whereFn: ReturnType<typeof vi.fn> = vi.fn()
        whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
        const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
        return { select } as never
      }
      return (fallbackDb.selectFrom as ReturnType<typeof vi.fn>)(table) as never
    })
    const db = baseDb

    mockMapJobErrorToUserMessage.mockReturnValue(
      "Job failed but error details could not be retrieved.",
    )
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const app = await buildApp(db, enqueueJob)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat?wait=true&timeout=5000`,
      payload: { text: "Fail test 2" },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    expect(body.status).toBe("FAILED")
    expect(body.error).toBeDefined()
    expect(body.error.message).toBe("Job failed but error details could not be retrieved.")
    expect(body.error.code).toBe("job_failed")
  })
})
