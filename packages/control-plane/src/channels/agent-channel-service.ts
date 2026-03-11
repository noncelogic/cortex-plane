/**
 * Agent Channel Service
 *
 * Maps chat channels (Telegram, Discord, etc.) to specific agents.
 * Provides lookup, bind, unbind, and default-agent operations.
 */

import type { Kysely } from "kysely"

import type { AgentChannelBinding, Database } from "../db/types.js"

/** Binding row enriched with the agent's name and slug. */
export interface BindingWithAgent {
  id: string
  agent_id: string
  agent_name: string
  agent_slug: string
  channel_type: string
  chat_id: string
  is_default: boolean
  created_at: Date
}

export class AgentChannelService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Find which agent handles messages from this chat.
   * Returns the agent ID or null if no binding exists.
   * Falls back to the default agent for the channel type.
   */
  async resolveAgent(channelType: string, chatId: string): Promise<string | null> {
    // Direct binding first
    const binding = await this.db
      .selectFrom("agent_channel_binding")
      .select("agent_id")
      .where("channel_type", "=", channelType)
      .where("chat_id", "=", chatId)
      .executeTakeFirst()

    if (binding) return binding.agent_id

    // Fall back to default agent for this channel type
    const defaultBinding = await this.db
      .selectFrom("agent_channel_binding")
      .select("agent_id")
      .where("channel_type", "=", channelType)
      .where("is_default", "=", true)
      .executeTakeFirst()

    return defaultBinding?.agent_id ?? null
  }

  /**
   * Bind a chat to an agent.
   * Upserts — if the (channel_type, chat_id) pair already exists, it updates the agent_id.
   */
  async bindChannel(agentId: string, channelType: string, chatId: string): Promise<void> {
    await this.db
      .insertInto("agent_channel_binding")
      .values({ agent_id: agentId, channel_type: channelType, chat_id: chatId })
      .onConflict((oc) =>
        oc.columns(["channel_type", "chat_id"]).doUpdateSet({ agent_id: agentId }),
      )
      .execute()
  }

  /**
   * Remove a binding by its ID.
   */
  async unbindById(agentId: string, bindingId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("agent_channel_binding")
      .where("id", "=", bindingId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst()

    return Number(result.numDeletedRows) > 0
  }

  /**
   * List all channel bindings for an agent.
   */
  async listBindings(agentId: string): Promise<AgentChannelBinding[]> {
    return this.db
      .selectFrom("agent_channel_binding")
      .selectAll()
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "desc")
      .execute()
  }

  /**
   * List bindings for a channel type, enriched with agent name/slug.
   */
  async listBindingsByChannelType(channelType: string): Promise<BindingWithAgent[]> {
    const rows = await this.db
      .selectFrom("agent_channel_binding")
      .innerJoin("agent", "agent.id", "agent_channel_binding.agent_id")
      .select([
        "agent_channel_binding.id",
        "agent_channel_binding.agent_id",
        "agent.name as agent_name",
        "agent.slug as agent_slug",
        "agent_channel_binding.channel_type",
        "agent_channel_binding.chat_id",
        "agent_channel_binding.is_default",
        "agent_channel_binding.created_at",
      ])
      .where("agent_channel_binding.channel_type", "=", channelType)
      .orderBy("agent_channel_binding.created_at", "desc")
      .execute()

    return rows as BindingWithAgent[]
  }

  /**
   * Set this agent as the default for a channel type.
   * Clears any existing default for that channel type first.
   */
  async setDefault(agentId: string, channelType: string): Promise<void> {
    // Clear existing defaults for this channel type
    await this.db
      .updateTable("agent_channel_binding")
      .set({ is_default: false })
      .where("channel_type", "=", channelType)
      .where("is_default", "=", true)
      .execute()

    // Set this agent as default — requires an existing binding
    // If no binding exists for this agent + channel_type, create one with a sentinel chat_id
    const existing = await this.db
      .selectFrom("agent_channel_binding")
      .select("id")
      .where("agent_id", "=", agentId)
      .where("channel_type", "=", channelType)
      .executeTakeFirst()

    if (existing) {
      await this.db
        .updateTable("agent_channel_binding")
        .set({ is_default: true })
        .where("id", "=", existing.id)
        .execute()
    } else {
      await this.db
        .insertInto("agent_channel_binding")
        .values({
          agent_id: agentId,
          channel_type: channelType,
          chat_id: `__default__${channelType}`,
          is_default: true,
        })
        .execute()
    }
  }
}
