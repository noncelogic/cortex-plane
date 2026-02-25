/**
 * Authentication & Authorization Middleware
 *
 * - requireAuth:        Fastify preHandler that validates credentials
 *                       (Bearer token or X-API-Key) and attaches a Principal.
 * - requireRole(role):  Factory returning a preHandler that checks the
 *                       principal for a specific role (returns 403 otherwise).
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify"

import { findApiKey } from "./api-keys.js"
import type { AuthConfig, AuthenticatedRequest, Principal } from "./types.js"

const DEV_PRINCIPAL: Principal = {
  userId: "dev-user",
  roles: ["operator", "approver", "admin"],
  displayName: "Dev User (no auth configured)",
  authMethod: "api_key",
}

/**
 * Create the core authentication preHandler hook.
 *
 * Extracts credentials from:
 *   1. Authorization: Bearer <key>
 *   2. X-API-Key: <key>
 *
 * On success, attaches `request.principal`.
 * On failure, returns 401.
 *
 * If `config.requireAuth` is false (dev mode), a warning-level log is
 * emitted and a synthetic dev principal is attached.
 */
export function createRequireAuth(config: AuthConfig): preHandlerHookHandler {
  return async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Extract credential from either header
    const authHeader = request.headers.authorization
    const apiKeyHeader = request.headers["x-api-key"]

    let plaintextKey: string | undefined

    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      plaintextKey = authHeader.slice(7)
    } else if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
      plaintextKey = apiKeyHeader
    }

    if (!plaintextKey) {
      if (!config.requireAuth) {
        request.log.warn("No auth credentials provided — dev mode, attaching synthetic principal")
        ;(request as AuthenticatedRequest).principal = DEV_PRINCIPAL
        return
      }
      reply.status(401).send({ error: "unauthorized", message: "Missing credentials" })
      return
    }

    // Look up the key
    const record = findApiKey(plaintextKey, config.apiKeys)
    if (!record) {
      if (!config.requireAuth) {
        request.log.warn("Invalid credentials — dev mode, attaching synthetic principal")
        ;(request as AuthenticatedRequest).principal = DEV_PRINCIPAL
        return
      }
      reply.status(401).send({ error: "unauthorized", message: "Invalid credentials" })
      return
    }

    const principal: Principal = {
      userId: record.userId,
      roles: record.roles,
      displayName: record.label,
      authMethod: "api_key",
    }

    ;(request as AuthenticatedRequest).principal = principal
  }
}

/**
 * Factory that returns a preHandler hook requiring a specific role.
 * Must run after requireAuth (expects `request.principal` to exist).
 */
export function createRequireRole(role: string): preHandlerHookHandler {
  return async function requireRole(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const principal = (request as AuthenticatedRequest).principal
    if (!principal) {
      reply.status(401).send({ error: "unauthorized", message: "No principal attached" })
      return
    }

    if (!principal.roles.includes(role)) {
      reply.status(403).send({
        error: "forbidden",
        message: `Role '${role}' required`,
      })
      return
    }
  }
}
