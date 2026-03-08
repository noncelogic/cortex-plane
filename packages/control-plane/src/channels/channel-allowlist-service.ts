/**
 * Channel Allowlist Service
 *
 * CRUD operations for per-channel user allowlists, inbound policy
 * management, and audit logging.  When a channel's inbound_policy is
 * "allowlist", only platform users explicitly added to the allowlist
 * may send messages through that channel.
 */

import type { Kysely } from "kysely"

import type { ChannelAllowlistEntry, ChannelInboundPolicy, Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AllowlistEntrySummary {
  id: string
  channel_config_id: string
  platform_user_id: string
  display_name: string | null
  note: string | null
  added_by: string | null
  created_at: Date
  updated_at: Date
}

export interface AuditLogEntry {
  id: string
  channel_config_id: string
  action: string
  platform_user_id: string | null
  performed_by: string | null
  detail: Record<string, unknown>
  created_at: Date
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ChannelAllowlistService {
  constructor(private readonly db: Kysely<Database>) {}

  /** List all allowlist entries for a channel. */
  async listEntries(channelConfigId: string): Promise<AllowlistEntrySummary[]> {
    const rows = await this.db
      .selectFrom("channel_allowlist")
      .selectAll()
      .where("channel_config_id", "=", channelConfigId)
      .orderBy("created_at", "asc")
      .execute()

    return rows as AllowlistEntrySummary[]
  }

  /** Add a user to the channel allowlist. Idempotent via ON CONFLICT. */
  async addEntry(
    channelConfigId: string,
    platformUserId: string,
    performedBy: string | null,
    displayName?: string | null,
    note?: string | null,
  ): Promise<AllowlistEntrySummary> {
    const row = await this.db
      .insertInto("channel_allowlist")
      .values({
        channel_config_id: channelConfigId,
        platform_user_id: platformUserId,
        display_name: displayName ?? null,
        note: note ?? null,
        added_by: performedBy,
      })
      .onConflict((oc) =>
        oc.columns(["channel_config_id", "platform_user_id"]).doUpdateSet({
          display_name: displayName ?? null,
          note: note ?? null,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()

    await this.recordAudit(channelConfigId, "entry_added", platformUserId, performedBy, {
      display_name: displayName ?? null,
    })

    return row as AllowlistEntrySummary
  }

  /** Remove a user from the channel allowlist by entry ID. */
  async removeEntry(
    entryId: string,
    performedBy: string | null,
  ): Promise<ChannelAllowlistEntry | undefined> {
    const row = await this.db
      .deleteFrom("channel_allowlist")
      .where("id", "=", entryId)
      .returningAll()
      .executeTakeFirst()

    if (row) {
      await this.recordAudit(
        row.channel_config_id,
        "entry_removed",
        row.platform_user_id,
        performedBy,
      )
    }

    return row
  }

  /** Check whether a platform user is allowed on a channel. */
  async isAllowed(channelConfigId: string, platformUserId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("channel_allowlist")
      .select("id")
      .where("channel_config_id", "=", channelConfigId)
      .where("platform_user_id", "=", platformUserId)
      .executeTakeFirst()

    return !!row
  }

  /** Get the inbound policy for a channel config. */
  async getPolicy(channelConfigId: string): Promise<ChannelInboundPolicy | undefined> {
    const row = await this.db
      .selectFrom("channel_config")
      .select("inbound_policy")
      .where("id", "=", channelConfigId)
      .executeTakeFirst()

    return row?.inbound_policy
  }

  /** Set the inbound policy for a channel config. */
  async setPolicy(
    channelConfigId: string,
    policy: ChannelInboundPolicy,
    performedBy: string | null,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("channel_config")
      .set({ inbound_policy: policy, updated_at: new Date() })
      .where("id", "=", channelConfigId)
      .executeTakeFirst()

    if (Number(result.numUpdatedRows) > 0) {
      await this.recordAudit(channelConfigId, "policy_changed", null, performedBy, { policy })
      return true
    }

    return false
  }

  /** Fetch audit log for a channel. */
  async getAuditLog(channelConfigId: string, limit = 50): Promise<AuditLogEntry[]> {
    const rows = await this.db
      .selectFrom("channel_allowlist_audit")
      .selectAll()
      .where("channel_config_id", "=", channelConfigId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute()

    return rows as AuditLogEntry[]
  }

  // -------------------------------------------------------------------------
  // Private — audit logging
  // -------------------------------------------------------------------------

  private async recordAudit(
    channelConfigId: string,
    action: string,
    platformUserId: string | null,
    performedBy: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db
      .insertInto("channel_allowlist_audit")
      .values({
        channel_config_id: channelConfigId,
        action,
        platform_user_id: platformUserId,
        performed_by: performedBy,
        detail,
      })
      .execute()
  }
}
