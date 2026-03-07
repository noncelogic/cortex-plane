import type {
  ApprovalNotification,
  CallbackQuery,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "@cortex/shared/channels"
import { Bot, InlineKeyboard } from "grammy"

import type { TelegramConfig } from "./config.js"
import { formatApprovalRequest } from "./formatter.js"

export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = "telegram" as const
  private bot: Bot
  private config: TelegramConfig
  private started = false
  private messageHandler?: (msg: InboundMessage) => Promise<void>
  private callbackHandler?: (callback: CallbackQuery) => Promise<void>

  constructor(config: TelegramConfig) {
    this.config = config
    this.bot = new Bot(config.botToken)

    // Register grammy filter handlers — dispatches to the app-level handler
    // set via onMessage()/onCallback(). Registered in the constructor so
    // they are available before start() resolves.
    this.bot.on("message:text", async (ctx) => {
      if (!this.messageHandler) return

      const userId = ctx.from?.id
      if (!userId) return

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

    this.bot.on("callback_query:data", async (ctx) => {
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

    this.bot.catch((_err: unknown) => {
      // Errors are silently absorbed to prevent unhandled rejections.
      // Production deployments should layer structured logging on top.
    })
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    this.started = true

    // Fire-and-forget — bot.start() runs long-polling indefinitely
    void this.bot.start({ allowed_updates: ["message", "callback_query"] })
    return Promise.resolve()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.bot.stop()
    this.started = false
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
          for (const b of row) {
            kb.text(b.text, b.callbackData)
          }
          return kb.row()
        }, new InlineKeyboard())
      : undefined

    const result = await this.bot.api.sendMessage(chatId, message.text, {
      parse_mode: "HTML",
      reply_parameters: message.replyToMessageId
        ? { message_id: Number(message.replyToMessageId) }
        : undefined,
      reply_markup: keyboard,
    })

    return String(result.message_id)
  }

  async sendApprovalRequest(chatId: string, request: ApprovalNotification): Promise<string> {
    const detailsCallbackData = request.approveCallbackData.replace(":a:", ":d:")
    const keyboard = new InlineKeyboard()
      .text("Approve", request.approveCallbackData)
      .text("Reject", request.rejectCallbackData)
      .row()
      .text("Details", detailsCallbackData)

    const text = formatApprovalRequest(request)

    const result = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
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
