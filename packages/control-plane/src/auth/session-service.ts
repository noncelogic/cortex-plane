/**
 * Dashboard Session Service
 *
 * Manages httpOnly cookie-backed sessions for dashboard authentication.
 * Sessions are stored in PostgreSQL with CSRF protection tokens.
 *
 * Features:
 *   - Session creation on OAuth callback
 *   - CSRF token validation for state-changing requests
 *   - Session refresh (sliding expiry)
 *   - Session cleanup (expired sessions)
 *   - Cookie serialization helpers
 */

import { createHash, randomBytes } from "node:crypto"

import type { Kysely } from "kysely"

import type { DashboardSession, Database, UserAccount, UserRole } from "../db/types.js"

export interface SessionUser {
  userId: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  role: UserRole
}

export interface SessionData {
  session: DashboardSession
  user: SessionUser
}

const SESSION_COOKIE_NAME = "cortex_session"
const CSRF_HEADER = "x-csrf-token"

export { CSRF_HEADER, SESSION_COOKIE_NAME }

export class SessionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly sessionMaxAge: number = 7 * 24 * 3600,
  ) {}

  /**
   * Create a new session for a user after successful OAuth login.
   * Returns the session ID (to be set as httpOnly cookie) and CSRF token.
   */
  async createSession(
    userId: string,
  ): Promise<{ sessionId: string; csrfToken: string; expiresAt: Date }> {
    const csrfToken = randomBytes(32).toString("hex")
    const expiresAt = new Date(Date.now() + this.sessionMaxAge * 1000)
    const refreshToken = createHash("sha256").update(randomBytes(32)).digest("hex")

    const session = await this.db
      .insertInto("dashboard_session")
      .values({
        user_account_id: userId,
        csrf_token: csrfToken,
        expires_at: expiresAt,
        refresh_token: refreshToken,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return {
      sessionId: session.id,
      csrfToken,
      expiresAt,
    }
  }

  /**
   * Validate a session ID from a cookie.
   * Returns the session + user data if valid, null otherwise.
   */
  async validateSession(sessionId: string): Promise<SessionData | null> {
    const row = await this.db
      .selectFrom("dashboard_session")
      .innerJoin("user_account", "user_account.id", "dashboard_session.user_account_id")
      .select([
        "dashboard_session.id",
        "dashboard_session.user_account_id",
        "dashboard_session.csrf_token",
        "dashboard_session.expires_at",
        "dashboard_session.refresh_token",
        "dashboard_session.created_at",
        "dashboard_session.last_active_at",
        "user_account.email",
        "user_account.display_name",
        "user_account.avatar_url",
        "user_account.role",
      ])
      .where("dashboard_session.id", "=", sessionId)
      .executeTakeFirst()

    if (!row) return null

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      await this.deleteSession(sessionId)
      return null
    }

    // Slide the session expiry if more than 10% of the TTL has passed
    const elapsed = Date.now() - new Date(row.last_active_at).getTime()
    if (elapsed > this.sessionMaxAge * 100) {
      // 10% of TTL in ms
      await this.db
        .updateTable("dashboard_session")
        .set({
          last_active_at: new Date(),
          expires_at: new Date(Date.now() + this.sessionMaxAge * 1000),
        })
        .where("id", "=", sessionId)
        .execute()
    }

    return {
      session: {
        id: row.id,
        user_account_id: row.user_account_id,
        csrf_token: row.csrf_token,
        expires_at: row.expires_at,
        refresh_token: row.refresh_token,
        created_at: row.created_at,
        last_active_at: row.last_active_at,
      },
      user: {
        userId: row.user_account_id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        role: row.role,
      },
    }
  }

  /**
   * Validate a CSRF token against the session.
   */
  validateCsrf(session: DashboardSession, csrfToken: string): boolean {
    return session.csrf_token === csrfToken
  }

  /**
   * Delete a session (logout).
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.db.deleteFrom("dashboard_session").where("id", "=", sessionId).execute()
  }

  /**
   * Delete all sessions for a user (force logout everywhere).
   */
  async deleteUserSessions(userId: string): Promise<number> {
    const result = await this.db
      .deleteFrom("dashboard_session")
      .where("user_account_id", "=", userId)
      .executeTakeFirst()

    return Number(result.numDeletedRows)
  }

  /**
   * Clean up expired sessions (call periodically or on startup).
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.db
      .deleteFrom("dashboard_session")
      .where("expires_at", "<", new Date())
      .executeTakeFirst()

    return Number(result.numDeletedRows)
  }

  /**
   * Serialize session cookie value with security flags.
   */
  static serializeCookie(sessionId: string, maxAge: number, secure: boolean): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=${sessionId}`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Max-Age=${String(maxAge)}`,
    ]
    if (secure) parts.push("Secure")
    return parts.join("; ")
  }

  /**
   * Serialize a session-clearing cookie.
   */
  static clearCookie(secure: boolean): string {
    const parts = [`${SESSION_COOKIE_NAME}=`, `Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=0`]
    if (secure) parts.push("Secure")
    return parts.join("; ")
  }

  /**
   * Extract session ID from a cookie header string.
   */
  static parseSessionCookie(cookieHeader: string | undefined): string | undefined {
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
}

/**
 * Find or create a user account from OAuth profile data.
 * On first login, creates a new user with the 'operator' role.
 */
export async function findOrCreateOAuthUser(
  db: Kysely<Database>,
  profile: {
    provider: string
    providerId: string
    email: string
    displayName: string | null
    avatarUrl: string | null
  },
): Promise<UserAccount> {
  // Try to find existing user by OAuth identity
  const existing = await db
    .selectFrom("user_account")
    .selectAll()
    .where("oauth_provider", "=", profile.provider)
    .where("oauth_provider_id", "=", profile.providerId)
    .executeTakeFirst()

  if (existing) {
    // Update profile fields on each login
    await db
      .updateTable("user_account")
      .set({
        display_name: profile.displayName ?? existing.display_name,
        email: profile.email,
        avatar_url: profile.avatarUrl ?? existing.avatar_url,
        updated_at: new Date(),
      })
      .where("id", "=", existing.id)
      .execute()

    return {
      ...existing,
      email: profile.email,
      display_name: profile.displayName ?? existing.display_name,
    }
  }

  // Check if email already exists (link accounts)
  const byEmail = await db
    .selectFrom("user_account")
    .selectAll()
    .where("email", "=", profile.email)
    .executeTakeFirst()

  if (byEmail) {
    // Link OAuth identity to existing email-based account
    await db
      .updateTable("user_account")
      .set({
        oauth_provider: profile.provider,
        oauth_provider_id: profile.providerId,
        avatar_url: profile.avatarUrl ?? byEmail.avatar_url,
        updated_at: new Date(),
      })
      .where("id", "=", byEmail.id)
      .execute()

    return { ...byEmail, oauth_provider: profile.provider, oauth_provider_id: profile.providerId }
  }

  // Create new user
  const newUser = await db
    .insertInto("user_account")
    .values({
      display_name: profile.displayName,
      email: profile.email,
      avatar_url: profile.avatarUrl,
      oauth_provider: profile.provider,
      oauth_provider_id: profile.providerId,
      role: "operator",
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return newUser
}
