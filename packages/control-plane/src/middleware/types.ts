/**
 * Auth types for middleware.
 *
 * Principal represents an authenticated actor (via API key or session).
 * AuthConfig controls how API keys are loaded and validated.
 */

import type { FastifyRequest } from "fastify"

import type { UserRole } from "../db/types.js"

export interface Principal {
  userId: string
  roles: string[]
  displayName: string
  authMethod: "api_key" | "bearer_token" | "session"
  /** Email (populated for session-based auth). */
  email?: string
  /** Dashboard user role (populated for session-based auth). */
  userRole?: UserRole
}

export interface ApiKeyRecord {
  /** SHA-256 hash of the API key (never store plaintext). */
  keyHash: string
  userId: string
  roles: string[]
  label: string
}

export interface AuthConfig {
  /** Configured API keys with associated roles. */
  apiKeys: ApiKeyRecord[]
  /**
   * When true, requests without valid credentials are rejected.
   * When false (dev mode), a warning is logged and a synthetic
   * principal is attached.
   */
  requireAuth: boolean
}

export interface AuthenticatedRequest extends FastifyRequest {
  principal: Principal
}
