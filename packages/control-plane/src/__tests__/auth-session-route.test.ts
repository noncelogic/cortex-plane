/**
 * Regression tests for /auth/session endpoint (issue #152).
 *
 * Verifies that the session endpoint correctly uses requireAuth middleware
 * to parse session cookies and return user data, instead of always 401-ing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"

import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest, Principal } from "../middleware/types.js"
import type { SessionService } from "../auth/session-service.js"

// ---------------------------------------------------------------------------
// Mock SessionService
// ---------------------------------------------------------------------------

function createMockSessionService(
  sessionData: { userId: string; email: string; displayName: string; avatarUrl: string | null; role: string } | null,
): SessionService {
  return {
    validateSession: vi.fn().mockResolvedValue(
      sessionData
        ? {
            session: {
              id: "sess-1",
              user_account_id: sessionData.userId,
              csrf_token: "csrf-tok",
              expires_at: new Date(Date.now() + 86400_000),
              refresh_token: "refresh-tok",
              created_at: new Date(),
              last_active_at: new Date(),
            },
            user: {
              userId: sessionData.userId,
              email: sessionData.email,
              displayName: sessionData.displayName,
              avatarUrl: sessionData.avatarUrl,
              role: sessionData.role,
            },
          }
        : null,
    ),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteUserSessions: vi.fn(),
    cleanupExpired: vi.fn(),
    validateCsrf: vi.fn().mockReturnValue(true),
  } as unknown as SessionService
}

// ---------------------------------------------------------------------------
// /auth/session with requireAuth preHandler — the fix for issue #152
// ---------------------------------------------------------------------------

describe("/auth/session with requireAuth preHandler", () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app.close()
  })

  it("returns user data when a valid session cookie is present", async () => {
    const mockSession = createMockSessionService({
      userId: "user-42",
      email: "test@example.com",
      displayName: "Test User",
      avatarUrl: "https://avatars.githubusercontent.com/u/123",
      role: "operator",
    })

    app = Fastify({ logger: false })
    const requireAuth: PreHandler = createRequireAuth({
      config: { apiKeys: [], requireAuth: true },
      sessionService: mockSession,
    })

    app.get(
      "/auth/session",
      { preHandler: [requireAuth] },
      async (request) => {
        const principal = (request as AuthenticatedRequest).principal
        return {
          userId: principal.userId,
          displayName: principal.displayName,
          email: principal.email ?? null,
          role: principal.userRole ?? null,
          authMethod: principal.authMethod,
        }
      },
    )

    await app.ready()

    const res = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: "cortex_session=sess-1" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.userId).toBe("user-42")
    expect(body.displayName).toBe("Test User")
    expect(body.email).toBe("test@example.com")
    expect(body.role).toBe("operator")
    expect(body.authMethod).toBe("session")
  })

  it("returns 401 when no session cookie is present", async () => {
    const mockSession = createMockSessionService(null)

    app = Fastify({ logger: false })
    const requireAuth: PreHandler = createRequireAuth({
      config: { apiKeys: [], requireAuth: true },
      sessionService: mockSession,
    })

    app.get(
      "/auth/session",
      { preHandler: [requireAuth] },
      async (request) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return { error: "unauthorized" }
        }
        return { userId: principal.userId }
      },
    )

    await app.ready()

    const res = await app.inject({
      method: "GET",
      url: "/auth/session",
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 401 when session cookie is expired/invalid", async () => {
    // validateSession returns null for invalid sessions
    const mockSession = createMockSessionService(null)

    app = Fastify({ logger: false })
    const requireAuth: PreHandler = createRequireAuth({
      config: { apiKeys: [], requireAuth: true },
      sessionService: mockSession,
    })

    app.get(
      "/auth/session",
      { preHandler: [requireAuth] },
      async (request) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return { error: "unauthorized" }
        }
        return { userId: principal.userId }
      },
    )

    await app.ready()

    const res = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: "cortex_session=expired-sess" },
    })

    expect(res.statusCode).toBe(401)
  })
})
