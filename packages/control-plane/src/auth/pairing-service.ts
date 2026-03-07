import { randomBytes } from "node:crypto"

import type { Kysely } from "kysely"

import type { Database, PairingCode } from "../db/types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAFE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
const CODE_LENGTH = 6
const MAX_RETRIES = 3
const DEFAULT_TTL_SECONDS = 3600

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateResult {
  code: string
  expiresAt: Date
}

export interface RedeemResult {
  success: boolean
  message: string
  grantId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  return Array.from(bytes)
    .map((b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length])
    .join("")
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505"
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PairingService {
  constructor(private readonly db: Kysely<Database>) {}

  async generate(
    agentId: string,
    createdBy: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<GenerateResult> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
          .returningAll()
          .executeTakeFirstOrThrow()
        return { code, expiresAt }
      } catch (err: unknown) {
        if (isUniqueViolation(err) && attempt < MAX_RETRIES) continue
        throw err
      }
    }

    /* istanbul ignore next -- unreachable: loop always returns or throws */
    throw new Error("Failed to generate unique pairing code")
  }

  async redeem(
    code: string,
    _channelMappingId: string,
    userAccountId: string,
  ): Promise<RedeemResult> {
    const row = await this.db
      .selectFrom("pairing_code")
      .selectAll()
      .where("code", "=", code)
      .executeTakeFirst()

    if (!row) return { success: false, message: "Invalid pairing code" }
    if (row.redeemed_at) return { success: false, message: "Code already redeemed" }
    if (row.revoked_at) return { success: false, message: "Code has been revoked" }
    if (new Date(row.expires_at) <= new Date())
      return { success: false, message: "Code has expired" }

    // Atomically mark as redeemed (guard against concurrent redemption)
    const updated = await this.db
      .updateTable("pairing_code")
      .set({ redeemed_by: userAccountId, redeemed_at: new Date() })
      .where("id", "=", row.id)
      .where("redeemed_at", "is", null)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst()

    if (!updated) return { success: false, message: "Code already redeemed or revoked" }

    // Create agent_user_grant when agent_id is present
    let grantId: string | undefined
    if (row.agent_id) {
      const grant = await this.db
        .insertInto("agent_user_grant")
        .values({
          agent_id: row.agent_id,
          user_account_id: userAccountId,
          origin: "pairing_code",
          granted_by: row.created_by,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      grantId = grant.id
    }

    return { success: true, message: "Pairing code redeemed", grantId }
  }

  async listActive(agentId: string): Promise<PairingCode[]> {
    return this.db
      .selectFrom("pairing_code")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("redeemed_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .execute()
  }

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
