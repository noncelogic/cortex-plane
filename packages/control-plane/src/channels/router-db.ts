/**
 * RouterDb implementation backed by Kysely.
 *
 * Implements the RouterDb interface from @cortex/shared/channels to resolve
 * channel-specific user identities to unified user_account records.
 */

import type { ResolvedUser, RouterDb } from "@cortex/shared/channels"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

export class KyselyRouterDb implements RouterDb {
  constructor(private readonly db: Kysely<Database>) {}

  async resolveUser(channelType: string, channelUserId: string): Promise<ResolvedUser | undefined> {
    const row = await this.db
      .selectFrom("channel_mapping")
      .innerJoin("user_account", "user_account.id", "channel_mapping.user_account_id")
      .select(["user_account.id as userAccountId", "channel_mapping.id as channelMappingId"])
      .where("channel_mapping.channel_type", "=", channelType)
      .where("channel_mapping.channel_user_id", "=", channelUserId)
      .executeTakeFirst()

    return row ?? undefined
  }

  async createUser(
    channelType: string,
    channelUserId: string,
    displayName: string | null,
  ): Promise<ResolvedUser> {
    const userAccount = await this.db
      .insertInto("user_account")
      .values({ display_name: displayName })
      .returning("id")
      .executeTakeFirstOrThrow()

    const channelMapping = await this.db
      .insertInto("channel_mapping")
      .values({
        user_account_id: userAccount.id,
        channel_type: channelType,
        channel_user_id: channelUserId,
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    return {
      userAccountId: userAccount.id,
      channelMappingId: channelMapping.id,
    }
  }
}
