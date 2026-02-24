import type { ApprovalNotification, CallbackQuery, InboundMessage } from "@cortex/shared/channels"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DiscordConfig } from "../config.js"

// ──────────────────────────────────────────────────
// Mock discord.js before importing DiscordAdapter
// ──────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => void

const mockLogin = vi.fn().mockResolvedValue("token")
const mockDestroy = vi.fn().mockResolvedValue(undefined)
const mockChannelFetch = vi.fn()
const mockCommandsSet = vi.fn().mockResolvedValue(undefined)

const eventHandlers = new Map<string, EventHandler>()

vi.mock("discord.js", () => {
  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    GuildMessageReactions: 4,
    MessageContent: 8,
  }

  const Events = {
    MessageCreate: "messageCreate",
    InteractionCreate: "interactionCreate",
    Error: "error",
  }

  const ChannelType = {
    PublicThread: 11,
  }

  const ButtonStyle = {
    Primary: 1,
    Secondary: 2,
    Success: 3,
    Danger: 4,
  }

  class MockClient {
    ws = { ping: 42 }
    application = {
      commands: { set: mockCommandsSet },
    }
    channels = { fetch: mockChannelFetch }

    constructor(_opts?: unknown) {
      // Reset handlers for each new instance
      eventHandlers.clear()
    }

    on(event: string, handler: EventHandler) {
      eventHandlers.set(event, handler)
      return this
    }

    login(token: string) {
      return mockLogin(token)
    }

    destroy() {
      return mockDestroy()
    }
  }

  class MockActionRowBuilder {
    private components: unknown[] = []

    addComponents(...args: unknown[]) {
      if (Array.isArray(args[0])) {
        this.components.push(...args[0])
      } else {
        this.components.push(...args)
      }
      return this
    }

    toJSON() {
      return { type: 1, components: this.components }
    }
  }

  class MockButtonBuilder {
    private data: Record<string, unknown> = {}

    setCustomId(id: string) {
      this.data["custom_id"] = id
      return this
    }

    setLabel(label: string) {
      this.data["label"] = label
      return this
    }

    setStyle(style: number) {
      this.data["style"] = style
      return this
    }

    toJSON() {
      return { type: 2, ...this.data }
    }
  }

  return {
    Client: MockClient,
    GatewayIntentBits,
    Events,
    ChannelType,
    ButtonStyle,
    ActionRowBuilder: MockActionRowBuilder,
    ButtonBuilder: MockButtonBuilder,
  }
})

// Import after mocks are set up
const { DiscordAdapter } = await import("../index.js")
const { GatewayIntentBits } = await import("discord.js")

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

const testConfig: DiscordConfig = {
  botToken: "test-token-123",
  applicationId: "app-123",
  allowedGuilds: new Set(["guild-111", "guild-222"]),
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
}

function getHandler(event: string): EventHandler {
  const h = eventHandlers.get(event)
  if (!h) throw new Error(`No handler for ${event}`)
  return h
}

function makeMessage(
  userId: string,
  content: string,
  opts: {
    channelId?: string
    guildId?: string | null
    isBot?: boolean
    messageId?: string
    isThread?: boolean
  } = {},
) {
  return {
    author: {
      id: userId,
      bot: opts.isBot ?? false,
      username: "testuser",
      displayName: "Test User",
    },
    channelId: opts.channelId ?? "channel-100",
    guildId: opts.guildId !== undefined ? opts.guildId : "guild-111",
    id: opts.messageId ?? "msg-42",
    content,
    reference: undefined as { messageId: string } | undefined,
    createdAt: new Date("2026-02-24T10:00:00Z"),
    channel: {
      isThread: () => opts.isThread ?? false,
    },
  }
}

function makeButtonInteraction(
  userId: string,
  customId: string,
  opts: {
    channelId?: string
    guildId?: string | null
    messageId?: string
  } = {},
) {
  return {
    isButton: () => true,
    user: { id: userId },
    channelId: opts.channelId ?? "channel-100",
    guildId: opts.guildId !== undefined ? opts.guildId : "guild-111",
    message: { id: opts.messageId ?? "msg-55" },
    customId,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  }
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────

describe("DiscordAdapter", () => {
  let adapter: InstanceType<typeof DiscordAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    eventHandlers.clear()
    adapter = new DiscordAdapter(testConfig)
  })

  describe("lifecycle", () => {
    it("has channelType 'discord'", () => {
      expect(adapter.channelType).toBe("discord")
    })

    it("start() calls client.login with bot token", async () => {
      await adapter.start()
      expect(mockLogin).toHaveBeenCalledWith("test-token-123")
    })

    it("start() is idempotent", async () => {
      await adapter.start()
      await adapter.start()
      expect(mockLogin).toHaveBeenCalledOnce()
    })

    it("stop() calls client.destroy", async () => {
      await adapter.start()
      await adapter.stop()
      expect(mockDestroy).toHaveBeenCalledOnce()
    })

    it("stop() before start() does nothing", async () => {
      await adapter.stop()
      expect(mockDestroy).not.toHaveBeenCalled()
    })
  })

  describe("healthCheck", () => {
    it("returns true when ws.ping >= 0", async () => {
      expect(await adapter.healthCheck()).toBe(true)
    })
  })

  describe("sendMessage", () => {
    it("sends plain text message", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "msg-99" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        send: mockSend,
      })

      const msgId = await adapter.sendMessage("channel-123", { text: "Hello" })

      expect(msgId).toBe("msg-99")
      expect(mockSend).toHaveBeenCalledWith({
        content: "Hello",
        reply: undefined,
        components: undefined,
      })
    })

    it("sends message with inline buttons", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "msg-100" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        send: mockSend,
      })

      const msgId = await adapter.sendMessage("channel-123", {
        text: "Choose:",
        inlineButtons: [
          [
            { text: "A", callbackData: "a" },
            { text: "B", callbackData: "b" },
          ],
        ],
      })

      expect(msgId).toBe("msg-100")
      const opts = mockSend.mock.calls[0]![0] as Record<string, unknown>
      expect(opts["components"]).toBeDefined()
      expect((opts["components"] as unknown[]).length).toBe(1)
    })

    it("sends message with reply_to", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "msg-101" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        send: mockSend,
      })

      await adapter.sendMessage("channel-123", {
        text: "reply",
        replyToMessageId: "msg-42",
      })

      const opts = mockSend.mock.calls[0]![0] as Record<string, unknown>
      expect(opts["reply"]).toEqual({ messageReference: "msg-42" })
    })

    it("throws for non-existent channel", async () => {
      mockChannelFetch.mockResolvedValue(null)

      await expect(
        adapter.sendMessage("bad-channel", { text: "test" }),
      ).rejects.toThrow("Channel not found: bad-channel")
    })
  })

  describe("sendApprovalRequest", () => {
    it("sends formatted approval with button components", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-02-24T10:00:00Z"))

      const mockSend = vi.fn().mockResolvedValue({ id: "msg-200" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        send: mockSend,
      })

      const notification: ApprovalNotification = {
        jobId: "abcdef12-3456-7890-abcd-ef1234567890",
        agentName: "devops-01",
        actionType: "Deploy to staging",
        actionDetail: "kubectl apply -f deploy/staging/app.yaml",
        approveCallbackData: "apr:a:abcdef1234567890abcdef1234567890",
        rejectCallbackData: "apr:r:abcdef1234567890abcdef1234567890",
        expiresAt: new Date("2026-02-25T10:00:00Z"),
      }

      const msgId = await adapter.sendApprovalRequest("channel-456", notification)

      expect(msgId).toBe("msg-200")
      expect(mockSend).toHaveBeenCalledOnce()

      const callArgs = mockSend.mock.calls[0]![0] as Record<string, unknown>
      expect((callArgs["content"] as string)).toContain("Approval Required")
      expect((callArgs["content"] as string)).toContain("devops")
      expect(callArgs["components"]).toBeDefined()
      expect((callArgs["components"] as unknown[]).length).toBe(1)

      vi.useRealTimers()
    })
  })

  describe("onMessage — guild allowlist", () => {
    it("invokes handler for allowed guilds", async () => {
      const handler = vi.fn<(msg: InboundMessage) => Promise<void>>().mockResolvedValue(undefined)
      adapter.onMessage(handler)
      await adapter.start()

      const messageHandler = getHandler("messageCreate")
      await messageHandler(makeMessage("user-1", "hello"))

      expect(handler).toHaveBeenCalledOnce()
      const msg = handler.mock.calls[0]![0]
      expect(msg.channelType).toBe("discord")
      expect(msg.channelUserId).toBe("user-1")
      expect(msg.text).toBe("hello")
      expect(msg.chatId).toBe("channel-100")
    })

    it("ignores messages from disallowed guilds", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onMessage(handler)
      await adapter.start()

      const messageHandler = getHandler("messageCreate")
      await messageHandler(makeMessage("user-1", "hacker", { guildId: "guild-999" }))

      expect(handler).not.toHaveBeenCalled()
    })

    it("allows all guilds when allowedGuilds is empty", async () => {
      const openAdapter = new DiscordAdapter({
        ...testConfig,
        allowedGuilds: new Set(),
      })

      const handler = vi.fn().mockResolvedValue(undefined)
      openAdapter.onMessage(handler)
      await openAdapter.start()

      const messageHandler = getHandler("messageCreate")
      await messageHandler(makeMessage("user-1", "anyone", { guildId: "guild-9999" }))

      expect(handler).toHaveBeenCalledOnce()
    })

    it("ignores bot messages", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onMessage(handler)
      await adapter.start()

      const messageHandler = getHandler("messageCreate")
      await messageHandler(makeMessage("bot-1", "bot msg", { isBot: true }))

      expect(handler).not.toHaveBeenCalled()
    })

    it("does not crash when no handler is registered", async () => {
      await adapter.start()

      const messageHandler = getHandler("messageCreate")
      // Should not throw
      await messageHandler(makeMessage("user-1", "hello"))
    })

    it("includes thread metadata for thread messages", async () => {
      const handler = vi.fn<(msg: InboundMessage) => Promise<void>>().mockResolvedValue(undefined)
      adapter.onMessage(handler)
      await adapter.start()

      const messageHandler = getHandler("messageCreate")
      await messageHandler(
        makeMessage("user-1", "thread msg", { channelId: "thread-500", isThread: true }),
      )

      expect(handler).toHaveBeenCalledOnce()
      const msg = handler.mock.calls[0]![0]
      expect(msg.metadata["threadId"]).toBe("thread-500")
    })
  })

  describe("onCallback — button interaction handling", () => {
    it("invokes callback handler for allowed guilds", async () => {
      const handler = vi.fn<(cb: CallbackQuery) => Promise<void>>().mockResolvedValue(undefined)
      adapter.onCallback(handler)
      await adapter.start()

      const interactionHandler = getHandler("interactionCreate")
      const interaction = makeButtonInteraction("user-1", "apr:a:abcdef1234567890abcdef1234567890")
      await interactionHandler(interaction)

      expect(handler).toHaveBeenCalledOnce()
      const cb = handler.mock.calls[0]![0]
      expect(cb.channelType).toBe("discord")
      expect(cb.channelUserId).toBe("user-1")
      expect(cb.data).toBe("apr:a:abcdef1234567890abcdef1234567890")
      expect(interaction.deferUpdate).toHaveBeenCalled()
    })

    it("rejects interaction from disallowed guilds", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onCallback(handler)
      await adapter.start()

      const interactionHandler = getHandler("interactionCreate")
      const interaction = makeButtonInteraction("user-1", "apr:a:0000", {
        guildId: "guild-999",
      })
      await interactionHandler(interaction)

      expect(handler).not.toHaveBeenCalled()
      expect(interaction.reply).toHaveBeenCalledWith({
        content: "You are not authorized.",
        ephemeral: true,
      })
    })

    it("defers update when no handler is registered", async () => {
      await adapter.start()

      const interactionHandler = getHandler("interactionCreate")
      const interaction = makeButtonInteraction("user-1", "apr:a:0000")
      await interactionHandler(interaction)

      expect(interaction.deferUpdate).toHaveBeenCalled()
    })

    it("replies with error when handler throws", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("db error"))
      adapter.onCallback(handler)
      await adapter.start()

      const interactionHandler = getHandler("interactionCreate")
      const interaction = makeButtonInteraction("user-1", "apr:a:0000")
      await interactionHandler(interaction)

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "An error occurred.",
        ephemeral: true,
      })
    })

    it("ignores non-button interactions", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onCallback(handler)
      await adapter.start()

      const interactionHandler = getHandler("interactionCreate")
      await interactionHandler({ isButton: () => false })

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("thread management", () => {
    it("creates a thread and returns its ID", async () => {
      const mockThreadCreate = vi.fn().mockResolvedValue({ id: "thread-new" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        threads: { create: mockThreadCreate },
      })

      const threadId = await adapter.createThread("channel-100", "Agent Session")

      expect(threadId).toBe("thread-new")
      expect(mockThreadCreate).toHaveBeenCalledWith({
        name: "Agent Session",
        type: 11, // ChannelType.PublicThread
      })
    })

    it("sends a message to a thread", async () => {
      const mockSend = vi.fn().mockResolvedValue({ id: "msg-thread-1" })
      mockChannelFetch.mockResolvedValue({
        isThread: () => true,
        send: mockSend,
      })

      const msgId = await adapter.sendToThread("thread-100", { text: "update" })

      expect(msgId).toBe("msg-thread-1")
      expect(mockSend).toHaveBeenCalledWith({ content: "update" })
    })

    it("throws if thread not found", async () => {
      mockChannelFetch.mockResolvedValue(null)

      await expect(
        adapter.sendToThread("bad-thread", { text: "test" }),
      ).rejects.toThrow("Thread not found: bad-thread")
    })
  })

  describe("slash commands", () => {
    it("registers slash commands on the application", async () => {
      await adapter.start()

      await adapter.registerSlashCommands([
        { name: "status", description: "Check agent status" },
        { name: "approve", description: "Approve a pending action" },
      ])

      expect(mockCommandsSet).toHaveBeenCalledWith([
        { name: "status", description: "Check agent status" },
        { name: "approve", description: "Approve a pending action" },
      ])
    })
  })

  describe("voice channel stubs", () => {
    it("joinVoiceChannel throws not implemented", async () => {
      await expect(adapter.joinVoiceChannel("vc-1")).rejects.toThrow(
        "Voice channel support is not yet implemented",
      )
    })

    it("leaveVoiceChannel throws not implemented", async () => {
      await expect(adapter.leaveVoiceChannel("vc-1")).rejects.toThrow(
        "Voice channel support is not yet implemented",
      )
    })
  })

  describe("error handler", () => {
    it("registers an error event handler", async () => {
      await adapter.start()
      expect(eventHandlers.has("error")).toBe(true)
    })
  })
})
