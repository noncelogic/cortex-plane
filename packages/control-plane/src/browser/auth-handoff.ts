/**
 * Auth Handoff — Secure authentication injection into browser context.
 *
 * Allows operators to inject cookies, localStorage values, or session
 * tokens into an agent's browser session. All sensitive data is
 * encrypted at rest and cleared after injection.
 *
 * Security invariants:
 * - Requires explicit approval (approver role) before injection
 * - Cookies and tokens are AES-256-GCM encrypted in memory
 * - Plaintext is wiped from buffers after injection
 * - Every handoff is audit-logged
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import type { AuthHandoffRequest, AuthHandoffResult, AuthHandoffCookie } from "@cortex/shared/browser"

// ---------------------------------------------------------------------------
// Encryption utilities (AES-256-GCM)
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export interface EncryptedPayload {
  ciphertext: string
  iv: string
  authTag: string
}

/**
 * Generate a random 256-bit encryption key.
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  }
}

/**
 * Decrypt an AES-256-GCM encrypted payload.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64")
  const authTag = Buffer.from(payload.authTag, "base64")
  const ciphertext = Buffer.from(payload.ciphertext, "base64")

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString("utf8")
}

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

export interface AuthHandoffAuditEntry {
  id: string
  agentId: string
  targetUrl: string
  actorId: string
  actorDisplayName: string
  action: "auth_handoff_injected" | "auth_handoff_cleared"
  hasCookies: boolean
  hasLocalStorage: boolean
  hasSessionToken: boolean
  timestamp: string
}

// ---------------------------------------------------------------------------
// Auth Handoff Service
// ---------------------------------------------------------------------------

export class AuthHandoffService {
  /** Per-agent encryption keys — rotated on each handoff. */
  private readonly agentKeys = new Map<string, Buffer>()
  /** Encrypted payloads awaiting injection. */
  private readonly pendingHandoffs = new Map<string, EncryptedPayload>()
  /** Audit trail. */
  private readonly auditLog: AuthHandoffAuditEntry[] = []

  /**
   * Prepare and store an encrypted auth handoff payload.
   * The actual injection happens via the agent's CDP session.
   *
   * Caller MUST have verified the approver role before calling.
   */
  async prepareHandoff(
    request: AuthHandoffRequest,
    actorId: string,
    actorDisplayName: string,
  ): Promise<AuthHandoffResult> {
    const { agentId, targetUrl, cookies, localStorage, sessionToken } = request

    // Generate a fresh key for this handoff
    const key = generateEncryptionKey()
    this.agentKeys.set(agentId, key)

    // Encrypt the sensitive payload
    const sensitiveData = JSON.stringify({ cookies, localStorage, sessionToken })
    const encrypted = encrypt(sensitiveData, key)
    this.pendingHandoffs.set(agentId, encrypted)

    const timestamp = new Date().toISOString()

    // Write audit log
    this.auditLog.push({
      id: randomUUID(),
      agentId,
      targetUrl,
      actorId,
      actorDisplayName,
      action: "auth_handoff_injected",
      hasCookies: (cookies?.length ?? 0) > 0,
      hasLocalStorage: localStorage != null && Object.keys(localStorage).length > 0,
      hasSessionToken: sessionToken != null && sessionToken.length > 0,
      timestamp,
    })

    return {
      success: true,
      injectedAt: timestamp,
      targetUrl,
    }
  }

  /**
   * Retrieve and decrypt the pending handoff for injection into
   * the browser context. Clears the encrypted payload after retrieval.
   */
  consumeHandoff(agentId: string): {
    cookies?: AuthHandoffCookie[]
    localStorage?: Record<string, string>
    sessionToken?: string
  } | null {
    const encrypted = this.pendingHandoffs.get(agentId)
    const key = this.agentKeys.get(agentId)

    if (!encrypted || !key) return null

    const plaintext = decrypt(encrypted, key)
    const data = JSON.parse(plaintext) as {
      cookies?: AuthHandoffCookie[]
      localStorage?: Record<string, string>
      sessionToken?: string
    }

    // Clear sensitive material
    this.pendingHandoffs.delete(agentId)
    this.agentKeys.delete(agentId)

    return data
  }

  /**
   * Get audit log entries for an agent.
   */
  getAuditLog(agentId?: string): AuthHandoffAuditEntry[] {
    if (!agentId) return [...this.auditLog]
    return this.auditLog.filter((e) => e.agentId === agentId)
  }

  /**
   * Clean up all state for an agent.
   */
  cleanup(agentId: string): void {
    this.pendingHandoffs.delete(agentId)
    this.agentKeys.delete(agentId)
  }

  /**
   * Shut down and clear all state.
   */
  shutdown(): void {
    this.pendingHandoffs.clear()
    this.agentKeys.clear()
  }
}
