import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionData } from "../auth/session-service.js"
import { authRoutes } from "../routes/auth.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "00000000-0000-0000-0000-000000000001"
const SESSION_ID = "test-session-id"
const SESSION_COOKIE = `cortex_session=${SESSION_ID}`

const sessionData: SessionData = {
  session: {
    id: SESSION_ID,
    user_account_id: USER_ID,
    csrf_token: "csrf-tok",
    expires_at: new Date(Date.now() + 86_400_000),
    refresh_token: null,
    created_at: new Date(),
    last_active_at: new Date(),
  },
  user: {
    userId: USER_ID,
    email: "test@example.com",
    displayName: "Test User",
    avatarUrl: null,
    role: "operator",
  },
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDeleteUserSessions = vi.fn<(userId: string) => Promise<number>>()
const mockValidateSession = vi.fn<(id: string) => Promise<SessionData | null>>()
const mockInsertInto = vi.fn()

function createMockSessionService() {
  return {
    deleteUserSessions: mockDeleteUserSessions,
    deleteSession: vi.fn(),
    validateSession: mockValidateSession,
    createSession: vi.fn(),
    cleanupExpired: vi.fn(),
  }
}

function createMockDb() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const values = vi.fn().mockReturnValue({ execute })
  mockInsertInto.mockReturnValue({ values })
  return { insertInto: mockInsertInto }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /auth/logout-all", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDeleteUserSessions.mockResolvedValue(3)
    mockValidateSession.mockResolvedValue(sessionData)

    app = Fastify()
    await app.register(
      authRoutes({
        db: createMockDb() as never,
        authConfig: {
          dashboardUrl: "http://localhost:3100",
          providers: {},
          sessionSecret: "test-session-secret-for-hmac-1234",
        },
        sessionService: createMockSessionService() as never,
        credentialService: {} as never,
      }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("returns 401 without authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout-all" })
    expect(res.statusCode).toBe(401)
  })

  it("deletes all user sessions and returns count", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: SESSION_COOKIE },
    })

    expect(res.statusCode).toBe(200)
    const body: { ok: boolean; sessionsDeleted: number } = res.json()
    expect(body.ok).toBe(true)
    expect(body.sessionsDeleted).toBe(3)
    expect(mockDeleteUserSessions).toHaveBeenCalledWith(USER_ID)
  })

  it("writes an audit log entry with event_type logout_all", async () => {
    await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: SESSION_COOKIE },
    })

    expect(mockInsertInto).toHaveBeenCalledWith("credential_audit_log")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const valuesCall = mockInsertInto.mock.results[0]!.value.values.mock.calls[0][0] as Record<
      string,
      unknown
    >
    expect(valuesCall.event_type).toBe("logout_all")
    expect(valuesCall.user_account_id).toBe(USER_ID)
    expect((valuesCall.details as Record<string, unknown>).sessionsDeleted).toBe(3)
  })

  it("clears the session cookie in the response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: SESSION_COOKIE },
    })

    const setCookie = res.headers["set-cookie"]
    expect(typeof setCookie).toBe("string")
    expect(setCookie as string).toContain("cortex_session=")
    expect(setCookie as string).toContain("Max-Age=0")
  })

  it("returns sessionsDeleted: 0 when user has no other sessions", async () => {
    mockDeleteUserSessions.mockResolvedValue(0)

    const res = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: SESSION_COOKIE },
    })

    expect(res.statusCode).toBe(200)
    const body: { sessionsDeleted: number } = res.json()
    expect(body.sessionsDeleted).toBe(0)
  })
})
