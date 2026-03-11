/**
 * Chat route: grant-level rate limit & token budget enforcement (#545).
 *
 * Verifies that the REST chat endpoint enforces per-grant rate_limit and
 * token_budget columns via UserRateLimiter, returning 429 when exceeded.
 */

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { UserRateLimiter } from "../auth/user-rate-limiter.js"
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
const GRANT_ID = "gggggggg-1111-2222-3333-444444444444"

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

    if (table === "agent_user_grant") {
      const executeTakeFirst = vi.fn().mockResolvedValue({
        rate_limit: { max_messages: 5, window_seconds: 3600 },
        token_budget: { max_tokens: 10000, window_seconds: 86400 },
      })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
      return { select: vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst }) }
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

function mockGuard(allowed: boolean, grantId?: string) {
  return {
    authorize: vi.fn().mockResolvedValue({
      allowed,
      userId: USER_ID,
      grantId: allowed ? (grantId ?? GRANT_ID) : undefined,
      reason: allowed ? "granted" : "denied",
      replyToUser: allowed ? undefined : "Access denied",
    }),
    handlePairingCode: vi.fn(),
    resolveOrCreateIdentity: vi.fn(),
  } as unknown as ChannelAuthGuard
}

function mockRateLimiter(allowed: boolean) {
  return {
    check: vi.fn().mockResolvedValue(
      allowed
        ? { allowed: true, reason: "allowed" }
        : {
            allowed: false,
            reason: "rate_limited",
            replyToUser: "You've reached the message limit (5 per hour). Please try again later.",
            retryAfterSeconds: 3600,
          },
    ),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    getUsageSummary: vi.fn(),
  } as unknown as UserRateLimiter
}

function mockBudgetExceededLimiter() {
  return {
    check: vi.fn().mockResolvedValue({
      allowed: false,
      reason: "budget_exceeded",
      replyToUser: "You've reached the token budget. Please try again later.",
      retryAfterSeconds: 86400,
    }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    getUsageSummary: vi.fn(),
  } as unknown as UserRateLimiter
}

async function buildApp(opts: {
  channelAuthGuard?: ChannelAuthGuard
  userRateLimiter?: UserRateLimiter
  db?: Kysely<Database>
}) {
  const app = Fastify({ logger: false })
  await app.register(
    chatRoutes({
      db: opts.db ?? mockDb(),
      authConfig: DEV_AUTH,
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      channelAuthGuard: opts.channelAuthGuard,
      userRateLimiter: opts.userRateLimiter,
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

  activePrincipal.value = {
    userId: USER_ID,
    roles: [],
    displayName: "Regular User",
    authMethod: "session",
    userRole: "approver",
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Grant-level rate limit enforcement in REST chat (#545)", () => {
  it("returns 429 when rate limit exceeded", async () => {
    const guard = mockGuard(true)
    const limiter = mockRateLimiter(false)
    const app = await buildApp({ channelAuthGuard: guard, userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe("rate_limited")
    expect(res.json().message).toContain("message limit")
    expect(res.headers["retry-after"]).toBe("3600")
    expect(limiter.check).toHaveBeenCalledWith(
      USER_ID,
      AGENT_ID,
      { max_messages: 5, window_seconds: 3600 },
      { max_tokens: 10000, window_seconds: 86400 },
    )
  })

  it("returns 429 when token budget exceeded", async () => {
    const guard = mockGuard(true)
    const limiter = mockBudgetExceededLimiter()
    const app = await buildApp({ channelAuthGuard: guard, userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe("budget_exceeded")
    expect(res.headers["retry-after"]).toBe("86400")
  })

  it("allows message when rate limiter approves", async () => {
    const guard = mockGuard(true)
    const limiter = mockRateLimiter(true)
    const app = await buildApp({ channelAuthGuard: guard, userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(202)
    expect(limiter.check).toHaveBeenCalled()
  })

  it("skips rate limiting for operators (no auth guard call)", async () => {
    activePrincipal.value = {
      userId: USER_ID,
      roles: ["operator"],
      displayName: "Operator",
      authMethod: "session",
      userRole: "operator",
    }
    const guard = mockGuard(false) // would deny if called
    const limiter = mockRateLimiter(false) // would deny if called
    const app = await buildApp({ channelAuthGuard: guard, userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello from operator" },
    })

    expect(res.statusCode).toBe(202)
    expect(guard.authorize).not.toHaveBeenCalled()
    expect(limiter.check).not.toHaveBeenCalled()
  })

  it("skips rate limiting when no auth guard is configured", async () => {
    const limiter = mockRateLimiter(false) // would deny if called
    const app = await buildApp({ userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(202)
    expect(limiter.check).not.toHaveBeenCalled()
  })

  it("skips rate limiting when grant has no grantId", async () => {
    const guard = {
      authorize: vi.fn().mockResolvedValue({
        allowed: true,
        userId: USER_ID,
        // no grantId — e.g. auto_open without grant row
        reason: "auto_open",
      }),
      handlePairingCode: vi.fn(),
      resolveOrCreateIdentity: vi.fn(),
    } as unknown as ChannelAuthGuard
    const limiter = mockRateLimiter(false) // would deny if called
    const app = await buildApp({ channelAuthGuard: guard, userRateLimiter: limiter })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/chat`,
      payload: { text: "Hello" },
    })

    expect(res.statusCode).toBe(202)
    expect(limiter.check).not.toHaveBeenCalled()
  })
})
