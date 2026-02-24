/**
 * Channel Message Router
 *
 * Resolves channel-specific user identities to unified user_account records.
 * Creates user_account + channel_mapping on first contact (auto-provision).
 * Routes inbound messages to the correct agent session context.
 *
 * The router accepts a database interface (RouterDb) to avoid coupling
 * the shared package to Kysely/pg. The control plane provides the
 * concrete implementation.
 *
 * See: docs/spec.md — Section 7.2 (Unified User Identity)
 * See: docs/spec.md — Section 15.1 (Unified Multi-Channel Routing)
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage } from "./types.js"

// ──────────────────────────────────────────────────
// Database Abstraction
// ──────────────────────────────────────────────────

export interface ResolvedUser {
  userAccountId: string
  channelMappingId: string
}

export interface RouterDb {
  /** Look up a user_account by channel_type + channel_user_id. */
  resolveUser(channelType: string, channelUserId: string): Promise<ResolvedUser | undefined>

  /** Create a new user_account and channel_mapping. Returns the new IDs. */
  createUser(
    channelType: string,
    channelUserId: string,
    displayName: string | null,
  ): Promise<ResolvedUser>
}

// ──────────────────────────────────────────────────
// Routed Message
// ──────────────────────────────────────────────────

export interface RoutedMessage {
  userAccountId: string
  channelMappingId: string
  message: InboundMessage
}

// ──────────────────────────────────────────────────
// Message Router
// ──────────────────────────────────────────────────

export type MessageHandler = (routed: RoutedMessage) => Promise<void>

export class MessageRouter {
  private handler: MessageHandler | undefined

  constructor(
    private readonly db: RouterDb,
    private readonly adapters: ReadonlyMap<string, ChannelAdapter>,
  ) {}

  /** Set the handler that receives resolved, routed messages. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler
  }

  /** Bind to all adapters' onMessage hooks. Call once after adapters are started. */
  bind(): void {
    for (const [, adapter] of this.adapters) {
      adapter.onMessage(async (msg) => this.route(msg))
    }
  }

  /** Resolve a channel user and invoke the message handler. */
  async route(msg: InboundMessage): Promise<void> {
    if (!this.handler) {
      throw new Error("No message handler registered on MessageRouter")
    }

    let resolved = await this.db.resolveUser(msg.channelType, msg.channelUserId)

    if (!resolved) {
      resolved = await this.db.createUser(msg.channelType, msg.channelUserId, null)
    }

    await this.handler({
      userAccountId: resolved.userAccountId,
      channelMappingId: resolved.channelMappingId,
      message: msg,
    })
  }

  /** Send an outbound message to a user's channel. */
  async send(channelType: string, chatId: string, message: OutboundMessage): Promise<string> {
    const adapter = this.adapters.get(channelType)
    if (!adapter) {
      throw new Error(`No adapter registered for channel type '${channelType}'`)
    }
    return adapter.sendMessage(chatId, message)
  }
}
