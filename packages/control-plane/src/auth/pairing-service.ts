/**
 * Pairing Service
 *
 * Generates, validates, and redeems pairing codes for channel authorization.
 * A pairing code is a short, human-readable code that grants a user access
 * to interact with an agent.
 *
 * Features:
 *   - Code generation from a safe alphabet (no ambiguous chars)
 *   - Collision-safe insert with retry
 *   - Code redemption with agent_user_grant creation
 *   - Active code listing and revocation
 */

import { randomBytes } from "node:crypto"

import type { Kysely } from "kysely"

import type { Database, PairingCode } from "../db/types.js"

/** Characters that cannot be confused visually (excludes 0/O, 1/I/L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const CODE_LENGTH = 6
const DEFAULT_TTL_SECONDS = 3600
const MAX_RETRIES = 3

export interface GenerateResult {
  code: string
  expiresAt: Date
}

export interface RedeemResult {
  pairingCodeId: string
  agentId: string | null
  grantId: string | null
}

/** Generate a random code from the safe alphabet using crypto.randomBytes. */
export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ""
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
  }
  return code
}

export class PairingService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Generate a new pairing code for an agent.
   * Retries up to 3 times on unique-constraint collision.
   */
  async generate(
    agentId: string | null,
    createdBy: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<GenerateResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      const code = generateCode()
      try {
        await this.db
          .insertInto("pairing_code")
          .values({
            code,
            agent_id: agentId,
            created_by: createdBy,
            expires_at: expiresAt,
          })
          .execute()

        return { code, expiresAt }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ""
        const isUniqueViolation = msg.includes("unique") || msg.includes("23505")
        if (!isUniqueViolation || retry === MAX_RETRIES) {
          throw err
        }
      }
    }

    /* istanbul ignore next -- unreachable after the loop above */
    throw new Error("Failed to generate unique pairing code")
  }

  /**
   * Validate and consume a pairing code.
   * If the code is tied to an agent, an agent_user_grant is created.
   */
  async redeem(
    code: string,
    channelMappingId: string,
    userAccountId: string,
  ): Promise<RedeemResult> {
    const row = await this.db
      .selectFrom("pairing_code")
      .selectAll()
      .where("code", "=", code.toUpperCase())
      .executeTakeFirst()

    if (!row) {
      throw new Error("Invalid pairing code")
    }
    if (row.revoked_at) {
      throw new Error("Pairing code has been revoked")
    }
    if (row.redeemed_at) {
      throw new Error("Pairing code already redeemed")
    }
    if (new Date(row.expires_at) < new Date()) {
      throw new Error("Pairing code has expired")
    }

    // Mark as redeemed
    await this.db
      .updateTable("pairing_code")
      .set({
        redeemed_by: userAccountId,
        redeemed_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute()

    // If agent_id is set, create agent_user_grant
    let grantId: string | null = null
    if (row.agent_id) {
      const grant = await this.db
        .insertInto("agent_user_grant")
        .values({
          agent_id: row.agent_id,
          user_account_id: userAccountId,
          access_level: "write",
          origin: "pairing_code",
          granted_by: row.created_by,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      grantId = grant.id
    }

    return {
      pairingCodeId: row.id,
      agentId: row.agent_id,
      grantId,
    }
  }

  /**
   * List unexpired, unredeemed codes for an agent.
   */
  async listActive(agentId: string): Promise<PairingCode[]> {
    return this.db
      .selectFrom("pairing_code")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("redeemed_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .orderBy("created_at", "desc")
      .execute()
  }

  /**
   * Invalidate a pairing code early.
   */
  async revoke(codeId: string): Promise<void> {
    await this.db
      .updateTable("pairing_code")
      .set({ revoked_at: new Date() })
      .where("id", "=", codeId)
      .where("redeemed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute()
  }
}
