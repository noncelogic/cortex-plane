/**
 * Approval Token Generation & Hashing
 *
 * Generates 256-bit cryptographically random tokens with SHA-256 hashing.
 * Token format: cortex_apr_1_<43 chars base64url>
 *
 * Only the SHA-256 hash is stored in the database.
 * The plaintext is sent in approval notifications and never persisted.
 */

import { createHash, randomBytes } from "node:crypto"

import { APPROVAL_TOKEN_PREFIX, APPROVAL_TOKEN_VERSION } from "@cortex/shared"

const TOKEN_ENTROPY_BYTES = 32 // 256 bits

export interface GeneratedToken {
  /** Plaintext token (for notifications). */
  plaintext: string
  /** SHA-256 hex hash (for database storage). */
  hash: string
}

/**
 * Generate a new approval token.
 * Returns both the plaintext (for the notification) and the hash (for storage).
 */
export function generateApprovalToken(): GeneratedToken {
  const entropy = randomBytes(TOKEN_ENTROPY_BYTES)
  const encoded = entropy.toString("base64url")
  const plaintext = `${APPROVAL_TOKEN_PREFIX}_${APPROVAL_TOKEN_VERSION}_${encoded}`
  const hash = hashApprovalToken(plaintext)
  return { plaintext, hash }
}

/**
 * Hash a plaintext token for lookup.
 * Used when validating an incoming approval/deny request.
 */
export function hashApprovalToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex")
}

/**
 * Validate token format without checking the database.
 * Returns true if the token has the expected prefix and version.
 *
 * Token format: cortex_apr_<version>_<base64url>
 * Note: base64url can contain underscores, so we match the fixed prefix.
 */
export function isValidTokenFormat(plaintext: string): boolean {
  const prefix = `${APPROVAL_TOKEN_PREFIX}_${APPROVAL_TOKEN_VERSION}_`
  if (!plaintext.startsWith(prefix)) return false
  // Must have some entropy after the prefix
  return plaintext.length > prefix.length
}
