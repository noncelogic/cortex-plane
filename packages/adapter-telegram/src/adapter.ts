import type {
  ApprovalNotification,
  CallbackQuery,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "@cortex/shared/channels"
import { Bot, InlineKeyboard } from "grammy"

import type { TelegramConfig } from "./config.js"

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = "telegram" as const
  private bot: Bot
  private config: TelegramConfig
  private messageHandler?: (msg: InboundMessage) => Promise<void>
  private callbackHandler?: (callback: CallbackQuery) => Promise<void>

  constructor(config: TelegramConfig) {
    this.config = config
    this.bot = new Bot(config.botToken)
  }

  async start(): Promise<void> {
    this.bot.on("message", async (ctx) => {
      if (!this.messageHandler) return

      const userId = ctx.from?.id
      if (!userId || !this.config.allowedUsers.has(userId)) {
        return
      }

      const inbound: InboundMessage = {
        channelType: this.channelType,
        channelUserId: String(userId),
        chatId: String(ctx.chat.id),
        messageId: String(ctx.message.message_id),
        text: ctx.message.text ?? "",
        replyToMessageId: ctx.message.reply_to_message?.message_id
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        timestamp: new Date(ctx.message.date * 1000),
        metadata: {
          username: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
        },
      }

      await this.messageHandler(inbound)
    })

    this.bot.on("callback_query", async (ctx) => {
      if (!this.callbackHandler || !ctx.callbackQuery.data) return

      const callback: CallbackQuery = {
        channelType: this.channelType,
        channelUserId: String(ctx.from?.id),
        chatId: String(ctx.callbackQuery.message?.chat.id),
        messageId: String(ctx.callbackQuery.message?.message_id),
        data: ctx.callbackQuery.data,
        timestamp: new Date(),
      }

      await this.callbackHandler(callback)
    })

    await this.bot.start()
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.bot.api.getMe()
      return true
    } catch {
      return false
    }
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const keyboard = message.inlineButtons
      ? message.inlineButtons.reduce((kb, row) => {
          const buttonRow = row.map((b) =>
            InlineKeyboard.text(b.text, b.callbackData)
          )
          return kb.row(...buttonRow)
        }, new InlineKeyboard())
      : undefined

    const result = await this.bot.api.sendMessage(
      Number(chatId),
      message.text,
      {
        reply_to_message_id: message.replyToMessageId
          ? Number(message.replyToMessageId)
          : undefined,
        reply_markup: keyboard,
      }
    )

    return String(result.message_id)
  }

  async sendApprovalRequest(
    chatId: string,
    request: ApprovalNotification
  ): Promise<string> {
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", request.approveCallbackData)
      .text("❌ Reject", request.rejectCallbackData)

    const text = [
      `🔐 *Approval Required*`,
      ``,
      `*Agent:* ${request.agentName}`,
      `*Action:* ${request.actionType}`,
      `*Detail:* ${request.actionDetail}`,
      `*Expires:* ${request.expiresAt.toLocaleString()}`,
    ].join("\n")

    const result = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    })

    return String(result.message_id)
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCallback(handler: (callback: CallbackQuery) => Promise<void>): void {
    this.callbackHandler = handler
  }
}
