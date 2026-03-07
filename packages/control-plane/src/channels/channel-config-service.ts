/**
 * Channel Config Service
 *
 * CRUD operations for channel adapter configurations (Telegram, Discord,
 * WhatsApp).  Sensitive config fields (bot tokens, API keys) are encrypted
 * at rest using AES-256-GCM via the credential-encryption module.
 */

import type { Kysely } from "kysely"

import {
  decrypt,
  deriveMasterKey,
  encrypt,
  type EncryptedValue,
} from "../auth/credential-encryption.js"
import type { ChannelConfig, ChannelType, Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Plain (decrypted) channel configuration values. */
export interface ChannelConfigPlain {
  /** Telegram: botToken; Discord: token; etc. */
  [key: string]: unknown
}

/** Shape returned to the API — secrets masked. */
export interface ChannelConfigSummary {
  id: string
  type: ChannelType
  name: string
  enabled: boolean
  created_by: string | null
  created_at: Date
  updated_at: Date
}

/** Shape returned when the full config is needed (e.g., by adapters). */
export interface ChannelConfigFull extends ChannelConfigSummary {
  config: ChannelConfigPlain
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ChannelConfigService {
  private readonly masterKey: Buffer

  constructor(
    private readonly db: Kysely<Database>,
    masterKeyPassphrase: string,
  ) {
    this.masterKey = deriveMasterKey(masterKeyPassphrase)
  }

  /** List all channel configs (secrets masked). */
  async list(): Promise<ChannelConfigSummary[]> {
    const rows = await this.db
      .selectFrom("channel_config")
      .select(["id", "type", "name", "enabled", "created_by", "created_at", "updated_at"])
      .orderBy("created_at", "desc")
      .execute()

    return rows as ChannelConfigSummary[]
  }

  /** Get a single config by ID (secrets masked). */
  async getById(id: string): Promise<ChannelConfigSummary | undefined> {
    const row = await this.db
      .selectFrom("channel_config")
      .select(["id", "type", "name", "enabled", "created_by", "created_at", "updated_at"])
      .where("id", "=", id)
      .executeTakeFirst()

    return row as ChannelConfigSummary | undefined
  }

  /** Get a single config by ID with decrypted config (for runtime use). */
  async getByIdFull(id: string): Promise<ChannelConfigFull | undefined> {
    const row = await this.db
      .selectFrom("channel_config")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()

    if (!row) return undefined
    return this.toFull(row)
  }

  /** List all enabled configs with decrypted config (for adapter startup). */
  async listEnabled(): Promise<ChannelConfigFull[]> {
    const rows = await this.db
      .selectFrom("channel_config")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "asc")
      .execute()

    return rows.map((r) => this.toFull(r))
  }

  /** Create a new channel config. Returns the summary (secrets masked). */
  async create(
    type: ChannelType,
    name: string,
    config: ChannelConfigPlain,
    createdBy: string | null,
  ): Promise<ChannelConfigSummary> {
    const configEnc = this.encryptConfig(config)

    const row = await this.db
      .insertInto("channel_config")
      .values({
        type,
        name,
        config_enc: configEnc,
        created_by: createdBy,
      })
      .returning(["id", "type", "name", "enabled", "created_by", "created_at", "updated_at"])
      .executeTakeFirstOrThrow()

    return row as ChannelConfigSummary
  }

  /** Update a channel config. Returns the updated summary or undefined if not found. */
  async update(
    id: string,
    updates: {
      name?: string
      config?: ChannelConfigPlain
      enabled?: boolean
    },
  ): Promise<ChannelConfigSummary | undefined> {
    const setClause: Record<string, unknown> = { updated_at: new Date() }
    if (updates.name !== undefined) setClause.name = updates.name
    if (updates.enabled !== undefined) setClause.enabled = updates.enabled
    if (updates.config !== undefined) {
      setClause.config_enc = this.encryptConfig(updates.config)
    }

    const row = await this.db
      .updateTable("channel_config")
      .set(setClause)
      .where("id", "=", id)
      .returning(["id", "type", "name", "enabled", "created_by", "created_at", "updated_at"])
      .executeTakeFirst()

    return row as ChannelConfigSummary | undefined
  }

  /** Delete a channel config. Returns true if deleted. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("channel_config")
      .where("id", "=", id)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  // ---------------------------------------------------------------------------
  // Encryption helpers
  // ---------------------------------------------------------------------------

  private encryptConfig(config: ChannelConfigPlain): string {
    const json = JSON.stringify(config)
    const encrypted = encrypt(json, this.masterKey)
    return serializeEncrypted(encrypted)
  }

  private decryptConfig(stored: string): ChannelConfigPlain {
    const payload = deserializeEncrypted(stored)
    const json = decrypt(payload, this.masterKey)
    return JSON.parse(json) as ChannelConfigPlain
  }

  private toFull(row: ChannelConfig): ChannelConfigFull {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      config: this.decryptConfig(row.config_enc),
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers (same format as credential-encryption.ts)
// ---------------------------------------------------------------------------

function serializeEncrypted(value: EncryptedValue): string {
  return `${value.iv}.${value.authTag}.${value.ciphertext}`
}

function deserializeEncrypted(stored: string): EncryptedValue {
  const parts = stored.split(".")
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format")
  }
  return { iv: parts[0]!, authTag: parts[1]!, ciphertext: parts[2]! }
}
