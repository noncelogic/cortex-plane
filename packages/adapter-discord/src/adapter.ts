import type {
  ApprovalNotification,
  CallbackQuery,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "@cortex/shared/channels"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  type Interaction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js"

import type { DiscordConfig } from "./config.js"
import { formatApprovalRequest } from "./formatter.js"

export class DiscordAdapter implements ChannelAdapter {
  readonly channelType = "discord" as const
  private client: Client
  private config: DiscordConfig
  private started = false
  private messageHandler?: (msg: InboundMessage) => Promise<void>
  private callbackHandler?: (callback: CallbackQuery) => Promise<void>

  constructor(config: DiscordConfig) {
    this.config = config
    this.client = new Client({ intents: config.intents })
  }

  async start(): Promise<void> {
    if (this.started) return

    this.client.on(Events.MessageCreate, (message: Message) => {
      void this.handleMessage(message)
    })

    this.client.on(Events.InteractionCreate, (interaction: Interaction) => {
      void this.handleInteraction(interaction)
    })

    this.client.on(Events.Error, (_error: Error) => {
      // Errors are silently absorbed to prevent unhandled rejections.
      // Production deployments should layer structured logging on top.
    })

    await this.client.login(this.config.botToken)
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.client.destroy()
    this.started = false
  }

  async healthCheck(): Promise<boolean> {
    try {
      return this.client.ws.ping >= 0
    } catch {
      return false
    }
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const channel = await this.resolveTextChannel(chatId)

    const components = message.inlineButtons
      ? message.inlineButtons.map((row) => {
          const actionRow = new ActionRowBuilder<ButtonBuilder>()
          actionRow.addComponents(
            row.map((b) =>
              new ButtonBuilder()
                .setCustomId(b.callbackData)
                .setLabel(b.text)
                .setStyle(ButtonStyle.Secondary),
            ),
          )
          return actionRow
        })
      : undefined

    const result = await channel.send({
      content: message.text,
      reply: message.replyToMessageId
        ? { messageReference: message.replyToMessageId }
        : undefined,
      components,
    })

    return result.id
  }

  async sendApprovalRequest(
    chatId: string,
    request: ApprovalNotification,
  ): Promise<string> {
    const channel = await this.resolveTextChannel(chatId)

    const text = formatApprovalRequest(request)

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(request.approveCallbackData)
        .setLabel("✅ Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(request.rejectCallbackData)
        .setLabel("❌ Reject")
        .setStyle(ButtonStyle.Danger),
    )

    const result = await channel.send({
      content: text,
      components: [row],
    })

    return result.id
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCallback(handler: (callback: CallbackQuery) => Promise<void>): void {
    this.callbackHandler = handler
  }

  // ──────────────────────────────────────────────────
  // Thread management
  // ──────────────────────────────────────────────────

  async createThread(channelId: string, name: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.isThread()) {
      throw new Error(`Channel ${channelId} is not a guild text channel`)
    }
    const thread = await (channel as TextChannel).threads.create({
      name,
      type: ChannelType.PublicThread,
    })
    return thread.id
  }

  async sendToThread(threadId: string, message: OutboundMessage): Promise<string> {
    const thread = await this.client.channels.fetch(threadId)
    if (!thread || !thread.isThread()) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const result = await (thread as ThreadChannel).send({
      content: message.text,
    })

    return result.id
  }

  // ──────────────────────────────────────────────────
  // Voice channel presence (stub for future integration)
  // ──────────────────────────────────────────────────

  async joinVoiceChannel(_channelId: string): Promise<void> {
    throw new Error("Voice channel support is not yet implemented")
  }

  async leaveVoiceChannel(_channelId: string): Promise<void> {
    throw new Error("Voice channel support is not yet implemented")
  }

  // ──────────────────────────────────────────────────
  // Private handlers
  // ──────────────────────────────────────────────────

  private async handleMessage(message: Message): Promise<void> {
    if (!this.messageHandler) return
    if (message.author.bot) return

    const guildId = message.guildId
    if (
      guildId &&
      this.config.allowedGuilds.size > 0 &&
      !this.config.allowedGuilds.has(guildId)
    ) {
      return
    }

    const inbound: InboundMessage = {
      channelType: this.channelType,
      channelUserId: message.author.id,
      chatId: message.channelId,
      messageId: message.id,
      text: message.content,
      replyToMessageId: message.reference?.messageId ?? undefined,
      timestamp: message.createdAt,
      metadata: {
        username: message.author.username,
        displayName: message.author.displayName,
        guildId: message.guildId,
        threadId: message.channel.isThread() ? message.channelId : undefined,
      },
    }

    await this.messageHandler(inbound)
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) return

    const guildId = interaction.guildId
    if (
      guildId &&
      this.config.allowedGuilds.size > 0 &&
      !this.config.allowedGuilds.has(guildId)
    ) {
      await interaction.reply({ content: "You are not authorized.", ephemeral: true })
      return
    }

    if (!this.callbackHandler) {
      await interaction.deferUpdate()
      return
    }

    const callback: CallbackQuery = {
      channelType: this.channelType,
      channelUserId: interaction.user.id,
      chatId: interaction.channelId,
      messageId: interaction.message.id,
      data: interaction.customId,
      timestamp: new Date(),
    }

    try {
      await this.callbackHandler(callback)
      await interaction.deferUpdate()
    } catch {
      await interaction.reply({ content: "An error occurred.", ephemeral: true })
    }
  }

  // ──────────────────────────────────────────────────
  // Slash command registration
  // ──────────────────────────────────────────────────

  async registerSlashCommands(
    commands: { name: string; description: string }[],
  ): Promise<void> {
    if (!this.client.application) {
      throw new Error("Client application not available — call start() first")
    }

    await this.client.application.commands.set(
      commands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
      })),
    )
  }

  // ──────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────

  private async resolveTextChannel(channelId: string): Promise<TextChannel | ThreadChannel> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`)
    }
    if (channel.isThread()) {
      return channel as ThreadChannel
    }
    if (!channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`Channel ${channelId} is not a guild text channel`)
    }
    return channel as TextChannel
  }
}
