/**
 * Message Dispatch Handler
 *
 * The message handler that MessageRouter.onMessage() calls:
 * 1. Receive RoutedMessage (user resolved)
 * 2. Look up agent binding for (channelType, chatId) via AgentChannelService
 * 3. If no binding, check for default agent for this channel type
 * 4. If still no agent, send a reply: "No agent is assigned to this chat."
 * 5. If agent found, find or create a session for (agent_id, user_account_id)
 * 6. Log the message + session info (execution backend comes in #233)
 */

import type { MessageRouter, RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { AgentChannelService } from "./agent-channel-service.js"

export interface MessageDispatchDeps {
  db: Kysely<Database>
  agentChannelService: AgentChannelService
  router: MessageRouter
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

const NO_AGENT_MESSAGE = "No agent is assigned to this chat. Use the dashboard to connect an agent."

/**
 * Create a message handler that dispatches routed messages to the correct agent session.
 */
export function createMessageDispatch(
  deps: MessageDispatchDeps,
): (msg: RoutedMessage) => Promise<void> {
  const { db, agentChannelService, router, logger = console } = deps

  return async function dispatch(routed: RoutedMessage): Promise<void> {
    const { channelType, chatId } = routed.message

    // Resolve the agent for this channel + chat
    const agentId = await agentChannelService.resolveAgent(channelType, chatId)

    if (!agentId) {
      // No agent bound — notify the user
      logger.warn(
        { channelType, chatId, userAccountId: routed.userAccountId },
        "No agent binding found for chat",
      )
      await router.send(channelType, chatId, { text: NO_AGENT_MESSAGE })
      return
    }

    // Find or create a session for (agent_id, user_account_id)
    const session = await findOrCreateSession(db, agentId, routed.userAccountId)

    // Log the dispatch (execution backend comes in #233)
    logger.info(
      {
        agentId,
        sessionId: session.id,
        userAccountId: routed.userAccountId,
        channelType,
        chatId,
        messageId: routed.message.messageId,
      },
      "Message dispatched to agent session",
    )
  }
}

async function findOrCreateSession(
  db: Kysely<Database>,
  agentId: string,
  userAccountId: string,
): Promise<{ id: string }> {
  // Try to find existing active session
  const existing = await db
    .selectFrom("session")
    .select("id")
    .where("agent_id", "=", agentId)
    .where("user_account_id", "=", userAccountId)
    .where("status", "=", "active")
    .executeTakeFirst()

  if (existing) return existing

  // Create a new session
  const created = await db
    .insertInto("session")
    .values({
      agent_id: agentId,
      user_account_id: userAccountId,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return created
}
