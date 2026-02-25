/**
 * Immutable Audit Trail for Approval Decisions
 *
 * Every approval decision writes a tamper-evident audit entry with:
 *   - Full actor metadata (userId, displayName, roles, authMethod, ip, userAgent)
 *   - SHA-256 hash chained to the previous entry for tamper evidence
 *   - Stored in the approval_audit_log table with enriched details
 *
 * The chain hash means that altering any entry invalidates all subsequent hashes.
 */

import { createHash } from "node:crypto"

import type { Principal } from "../middleware/types.js"

export interface AuditActorMetadata {
  userId: string
  displayName: string
  roles: string[]
  authMethod: string
  ip: string
  userAgent: string
  decidedAt: string
}

export interface AuditEntry {
  requestId: string
  decision: string
  actor: AuditActorMetadata
  timestamp: string
  ip: string
  userAgent: string
  previousHash: string | null
  entryHash: string
}

/**
 * Build actor metadata from an authenticated principal and request context.
 */
export function buildActorMetadata(
  principal: Principal,
  ip: string,
  userAgent: string,
): AuditActorMetadata {
  return {
    userId: principal.userId,
    displayName: principal.displayName,
    roles: [...principal.roles],
    authMethod: principal.authMethod,
    ip,
    userAgent,
    decidedAt: new Date().toISOString(),
  }
}

/**
 * Compute the SHA-256 hash for an audit entry.
 * The hash includes the previous entry's hash for chain integrity.
 */
export function computeEntryHash(
  requestId: string,
  decision: string,
  actor: AuditActorMetadata,
  timestamp: string,
  previousHash: string | null,
): string {
  const payload = JSON.stringify({
    requestId,
    decision,
    actor,
    timestamp,
    previousHash: previousHash ?? "",
  })
  return createHash("sha256").update(payload).digest("hex")
}

/**
 * Create a complete audit entry with a chained hash.
 */
export function createAuditEntry(
  requestId: string,
  decision: string,
  actor: AuditActorMetadata,
  previousHash: string | null,
): AuditEntry {
  const timestamp = actor.decidedAt
  const entryHash = computeEntryHash(requestId, decision, actor, timestamp, previousHash)

  return {
    requestId,
    decision,
    actor,
    timestamp,
    ip: actor.ip,
    userAgent: actor.userAgent,
    previousHash,
    entryHash,
  }
}

/**
 * Verify a chain of audit entries for tamper evidence.
 * Returns true if all hashes are valid and properly chained.
 */
export function verifyAuditChain(entries: AuditEntry[]): boolean {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const expectedPrev = i === 0 ? null : entries[i - 1]!.entryHash

    if (entry.previousHash !== expectedPrev) {
      return false
    }

    const recomputed = computeEntryHash(
      entry.requestId,
      entry.decision,
      entry.actor,
      entry.timestamp,
      entry.previousHash,
    )

    if (recomputed !== entry.entryHash) {
      return false
    }
  }

  return true
}
