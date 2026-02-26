/**
 * Authentication & Authorization Middleware
 *
 * Supports three authentication methods (checked in order):
 *   1. Session cookie (httpOnly, set by OAuth login flow)
 *   2. Authorization: Bearer <key>
 *   3. X-API-Key: <key>
 *
 * - requireAuth:        Fastify preHandler that validates credentials and attaches a Principal.
 * - requireRole(role):  Factory returning a preHandler that checks the principal for a specific role.
 * - requireCsrf:        PreHandler that validates CSRF token for session-based requests.
 */

import type { FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import { CSRF_HEADER, SESSION_COOKIE_NAME } from "../auth/session-service.js"
import { findApiKey } from "./api-keys.js"
import type { AuthConfig, AuthenticatedRequest, Principal } from "./types.js"

/** Pre-handler hook that works as both sync and async in Fastify route config. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void

const ROLE_MAP: Record<string, string[]> = {
  admin: ["operator", "approver", "admin"],
  approver: ["operator", "approver"],
  operator: ["operator"],
}

const DEV_PRINCIPAL: Principal = {
  userId: "dev-user",
  roles: ["operator", "approver", "admin"],
  displayName: "Dev User (no auth configured)",
  authMethod: "api_key",
}

export interface AuthMiddlewareOptions {
  config: AuthConfig
  sessionService?: SessionService
}

/**
 * Create the core authentication preHandler hook.
 *
 * Checks (in order):
 *   1. Session cookie → session lookup → Principal from user_account
 *   2. Authorization: Bearer <key> → API key lookup
 *   3. X-API-Key: <key> → API key lookup
 *
 * On success, attaches `request.principal`.
 * On failure, returns 401.
 */
export function createRequireAuth(configOrOptions: AuthConfig | AuthMiddlewareOptions): PreHandler {
  // Distinguish AuthConfig (has apiKeys) from AuthMiddlewareOptions (has config)
  const options: AuthMiddlewareOptions =
    "apiKeys" in configOrOptions ? { config: configOrOptions } : configOrOptions
  const { config, sessionService } = options

  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 1. Try session cookie
    if (sessionService) {
      const cookieHeader = request.headers.cookie
      const sessionId = parseSessionCookie(cookieHeader)

      if (sessionId) {
        const sessionData = await sessionService.validateSession(sessionId)
        if (sessionData) {
          const roles = ROLE_MAP[sessionData.user.role] ?? [sessionData.user.role]
          const principal: Principal = {
            userId: sessionData.user.userId,
            roles,
            displayName: sessionData.user.displayName ?? sessionData.user.email ?? "User",
            authMethod: "session",
            email: sessionData.user.email ?? undefined,
            userRole: sessionData.user.role,
          }
          ;(request as AuthenticatedRequest).principal = principal
          return
        }
      }
    }

    // 2. Try API key (Bearer or X-API-Key header)
    const authHeader = request.headers.authorization
    const apiKeyHeader = request.headers["x-api-key"]

    let plaintextKey: string | undefined

    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      plaintextKey = authHeader.slice(7)
    } else if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
      plaintextKey = apiKeyHeader
    }

    if (plaintextKey) {
      const record = findApiKey(plaintextKey, config.apiKeys)
      if (record) {
        const principal: Principal = {
          userId: record.userId,
          roles: record.roles,
          displayName: record.label,
          authMethod: "api_key",
        }
        ;(request as AuthenticatedRequest).principal = principal
        return
      }
    }

    // 3. No valid credentials
    if (!config.requireAuth) {
      request.log.warn("No auth credentials provided — dev mode, attaching synthetic principal")
      ;(request as AuthenticatedRequest).principal = DEV_PRINCIPAL
      return
    }

    reply.status(401).send({ error: "unauthorized", message: "Missing or invalid credentials" })
  }
}

/**
 * Factory that returns a preHandler hook requiring a specific role.
 * Must run after requireAuth (expects `request.principal` to exist).
 */
export function createRequireRole(role: string): PreHandler {
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify needs Promise return to avoid waiting for done() callback
  return async function requireRole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

/**
 * PreHandler that validates CSRF token for state-changing requests
 * (POST, PUT, DELETE) when authenticated via session cookie.
 * API key-based requests skip CSRF validation.
 */
export function createRequireCsrf(sessionService: SessionService): PreHandler {
  return async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = (request as AuthenticatedRequest).principal
    if (!principal || principal.authMethod !== "session") return // API key auth — no CSRF needed

    const csrfToken = request.headers[CSRF_HEADER]
    if (typeof csrfToken !== "string" || csrfToken.length === 0) {
      reply.status(403).send({ error: "forbidden", message: "Missing CSRF token" })
      return
    }

    // Look up the session to validate the CSRF token
    const cookieHeader = request.headers.cookie
    const sessionId = parseSessionCookie(cookieHeader)
    if (!sessionId) {
      reply.status(403).send({ error: "forbidden", message: "Session not found" })
      return
    }

    const sessionData = await sessionService.validateSession(sessionId)
    if (!sessionData || !sessionService.validateCsrf(sessionData.session, csrfToken)) {
      reply.status(403).send({ error: "forbidden", message: "Invalid CSRF token" })
    }
  }
}

function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  const prefix = `${SESSION_COOKIE_NAME}=`
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length)
    }
  }
  return undefined
}
