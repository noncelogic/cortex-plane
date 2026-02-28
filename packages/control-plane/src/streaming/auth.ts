/**
 * Per-session token authentication for SSE streaming endpoints.
 *
 * Supports two authentication methods (checked in order):
 *   1. Session cookie (httpOnly, set by OAuth login flow) — used by browser
 *      EventSource which cannot send custom headers.
 *   2. Authorization: Bearer <session-id> — used by programmatic clients.
 *
 * Bearer tokens are validated against the agent session table. Each session has
 * an agent_id, so the middleware also verifies that the token grants access to
 * the requested agent.
 *
 * Cookie-based sessions are validated via the dashboard SessionService. Dashboard
 * users are granted access to any agent's stream.
 */

import type { FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import { SESSION_COOKIE_NAME } from "../auth/session-service.js"
import type { Database } from "../db/types.js"

export interface AuthContext {
  sessionId: string
  agentId: string
  userAccountId: string
}

export interface StreamAuthOptions {
  db: Kysely<Database>
  sessionService?: SessionService
}

/**
 * Create an authentication hook for agent streaming routes.
 *
 * When a SessionService is provided, dashboard session cookies are checked
 * first (required for browser EventSource which cannot set headers).
 * Falls back to Bearer token validation against the agent session table.
 */
export function createStreamAuth(dbOrOptions: Kysely<Database> | StreamAuthOptions) {
  const options: StreamAuthOptions = "selectFrom" in dbOrOptions ? { db: dbOrOptions } : dbOrOptions
  const { db, sessionService } = options

  return async function streamAuth(
    request: FastifyRequest<{ Params: { agentId: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const agentId = request.params.agentId

    // 1. Try session cookie (dashboard sessions — EventSource cannot send headers)
    if (sessionService) {
      const cookieHeader = request.headers.cookie
      const sessionId = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME)

      if (sessionId) {
        const sessionData = await sessionService.validateSession(sessionId)
        if (sessionData) {
          ;(request as AuthenticatedRequest).authContext = {
            sessionId,
            agentId,
            userAccountId: sessionData.user.userId,
          }
          return
        }
      }
    }

    // 2. Try Bearer token (agent execution sessions)
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "Missing or invalid Authorization header",
      })
    }

    const token = authHeader.slice(7)
    if (!token) {
      return reply.status(401).send({
        error: "unauthorized",
        message: "Empty bearer token",
      })
    }

    try {
      const session = await db
        .selectFrom("session")
        .select(["id", "agent_id", "user_account_id", "status"])
        .where("id", "=", token)
        .where("status", "=", "active")
        .executeTakeFirst()

      if (!session) {
        return reply.status(401).send({
          error: "unauthorized",
          message: "Invalid or expired session token",
        })
      }

      if (session.agent_id !== agentId) {
        return reply.status(403).send({
          error: "forbidden",
          message: "Session does not have access to this agent",
        })
      }

      // Attach auth context to request for downstream handlers
      ;(request as AuthenticatedRequest).authContext = {
        sessionId: session.id,
        agentId: session.agent_id,
        userAccountId: session.user_account_id,
      }
    } catch (error) {
      request.log.error(error, "Session auth lookup failed")
      return reply.status(500).send({
        error: "internal_error",
        message: "Authentication check failed",
      })
    }
  }
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  const prefix = `${name}=`
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length)
    }
  }
  return undefined
}

export interface AuthenticatedRequest extends FastifyRequest {
  authContext: AuthContext
}
