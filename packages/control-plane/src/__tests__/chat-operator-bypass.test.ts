/**
 * Chat route: operator bypass of channelAuthGuard (#529).
 *
 * Verifies that dashboard operators (userRole === "operator") skip the
 * per-agent auth guard, while non-operator users still go through it.
 */

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { Database } from "../db/types.js"
import type { AuthConfig, AuthenticatedRequest, Principal } from "../middleware/types.js"
import { chatRoutes } from "../routes/chat.js"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRunPreflight = vi.hoisted(() => vi.fn())
vi.mock("../channels/preflight.js", () => ({
  runPreflight: mockRunPreflight,
  mapJobErrorToUserMessage: vi.fn().mockReturnValue("Something went wrong."),
}))

const mockLoadConversationHistory = vi.hoisted(() => vi.fn())
const mockWatchJobCompletion = vi.hoisted(() => vi.fn())
vi.mock("../channels/message-dispatch.js", () => ({
  loadConversationHistory: mockLoadConversationHistory,
  watchJobCompletion: mockWatchJobCompletion,
}))

vi.mock("../util/name-uuid.js", () => ({
  ensureUuid: vi.fn((v: string) => v),
}))

/** Principal to inject — set per-test via `activePrincipal`. */
const activePrincipal = vi.hoisted(() => ({ value: null as Principal | null }))

vi.mock("../middleware/auth.js", () => ({
  createRequireAuth:
    () =>
    // eslint-disable-next-line @typescript-eslint/require-await
    async (request: import("fastify").FastifyRequest) => {
      ;(request as AuthenticatedRequest).principal = activePrincipal.value!
    },
}))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ID = "uuuuuuuu-1111-2222-3333-444444444444"

const DEV_AUTH: AuthConfig = { requireAuth: false, apiKeys: [] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDb() {
  const session = { id: SESSION_ID }
  const job = { id: "job-1111" }

  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "user_account") {
      const executeTakeFirst = vi.fn().mockResolvedValue({ id: USER_ID })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
      return { select: vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst }) }
    }

    if (table === "session") {
      const executeTakeFirst = vi.fn().mockResolvedValue(session)
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(session)
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, executeTakeFirst, executeTakeFirstOrThrow })
      return {
        select: vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst }),
        selectAll: vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst }),
      }
    }

    // Fallback
    const executeTakeFirst = vi.fn().mockResolvedValue(null)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
    return { select: vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst }) }
  })

  const insertIntoFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session_message") {
      const execute = vi.fn().mockResolvedValue(undefined)
      return { values: vi.fn().mockReturnValue({ execute }) }
    }
    // job insert
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(job)
    const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
    return { values: vi.fn().mockReturnValue({ returning }) }
  })

  const updateTableFn = vi.fn().mockImplementation(() => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, execute })
    return { set: vi.fn().mockReturnValue({ where: whereFn, execute }) }
  })

  return {
    selectFrom: selectFromFn,
    insertInto: insertIntoFn,
    updateTable: updateTableFn,
  } as unknown as Kysely<Database>
}

function mockGuard(allowed: boolean) {
  return {
    authorize: vi.fn().mockResolvedValue({
      allowed,
      userId: USER_ID,
      reason: allowed ? "granted" : "denied",
      replyToUser: allowed
        ? undefined
        : "This agent is private. Ask an operator for a pairing code.",
    }),
    handlePairingCode: vi.fn(),
    resolveOrCreateIdentity: vi.fn(),
  } as unknown as ChannelAuthGuard
}

async function buildApp(channelAuthGuard?: ChannelAuthGuard) {
  const app = Fastify({ logger: false })
  await app.register(
    chatRoutes({
      db: mockDb(),
      authConfig: DEV_AUTH,
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      channelAuthGuard,
    }),
  )
  return app
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockRunPreflight.mockResolvedValue({ ok: true })
  mockLoadConversationHistory.mockResolvedValue([])
  mockWatchJobCompletion.mockImplementation(() => {})
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Operator bypass of channelAuthGuard (#529)", () => {
  it("operator skips channelAuthGuard and proceeds to chat", async () => {
    activePrincipal.value = {
      userId: USER_ID,
      roles: ["operator"],
      displayName: "Test Operator",
      authMethod: "session",
      userRole: "operator",
    }
    const guard = mockGuard(false) // would reject if called
    const app = await buildApp(guard)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello from operator" },
    })

    expect(res.statusCode).toBe(202)
    expect(guard.authorize).not.toHaveBeenCalled()
  })

  it("non-operator user still goes through channelAuthGuard", async () => {
    activePrincipal.value = {
      userId: USER_ID,
      roles: [],
      displayName: "Regular User",
      authMethod: "session",
      userRole: "approver",
    }
    const guard = mockGuard(true)
    const app = await buildApp(guard)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello from user" },
    })

    expect(res.statusCode).toBe(202)
    expect(guard.authorize).toHaveBeenCalled()
  })

  it("non-operator user rejected by guard gets 403", async () => {
    activePrincipal.value = {
      userId: USER_ID,
      roles: [],
      displayName: "Regular User",
      authMethod: "session",
      userRole: "approver",
    }
    const guard = mockGuard(false)
    const app = await buildApp(guard)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello from user" },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe("forbidden")
    expect(res.json().message).toContain("pairing code")
    expect(guard.authorize).toHaveBeenCalled()
  })
})
