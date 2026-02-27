/**
 * Per-session token authentication for SSE streaming endpoints.
 *
 * Tokens are validated against the session table. Each session has
 * an agent_id, so the middleware also verifies that the token grants
 * access to the requested agent.
 *
 * Token format: Bearer <session-id>
 * In production this would be a signed JWT or opaque token; for now
 * we use the session ID directly with a DB lookup.
 */

import type { FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

export interface AuthContext {
  sessionId: string
  agentId: string
  userAccountId: string
}

/**
 * Create an authentication hook for agent streaming routes.
 * Extracts Bearer token, validates against the session table,
 * and verifies the session grants access to the requested agent.
 */
export function createStreamAuth(db: Kysely<Database>) {
  return async function streamAuth(
    request: FastifyRequest<{ Params: { agentId: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
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

    const agentId = request.params.agentId

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

export interface AuthenticatedRequest extends FastifyRequest {
  authContext: AuthContext
}
