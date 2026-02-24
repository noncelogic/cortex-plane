import type { ApprovalNotification, CallbackQuery, InboundMessage } from "@cortex/shared/channels"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TelegramConfig } from "../config.js"

// ──────────────────────────────────────────────────
// Mock grammy before importing TelegramAdapter
// ──────────────────────────────────────────────────

type Handler = (...args: unknown[]) => Promise<void>

const mockSendMessage = vi.fn()
const mockGetMe = vi.fn()
const mockStart = vi.fn()
const mockStop = vi.fn()
const messageHandlers = new Map<string, Handler>()
let errorHandler: ((err: { error: unknown }) => void) | null = null

vi.mock("grammy", () => {
  class MockBot {
    api = {
      sendMessage: mockSendMessage,
      getMe: mockGetMe,
    }

    on(filter: string, handler: Handler) {
      messageHandlers.set(filter, handler)
    }

    catch(handler: (err: { error: unknown }) => void) {
      errorHandler = handler
    }

    start(_opts?: unknown) {
      mockStart(_opts)
      return new Promise<void>(() => {
        /* never resolves, like real grammy */
      })
    }

    stop() {
      mockStop()
      return Promise.resolve()
    }
  }

  class MockInlineKeyboard {
    private rows: { text: string; callback_data: string }[][] = [[]]

    text(text: string, data: string) {
      this.rows[this.rows.length - 1]!.push({ text, callback_data: data })
      return this
    }

    row() {
      this.rows.push([])
      return this
    }

    get inline_keyboard() {
      return this.rows.filter((r) => r.length > 0)
    }
  }

  return {
    Bot: MockBot,
    InlineKeyboard: MockInlineKeyboard,
  }
})

// Import after mocks are set up
const { TelegramAdapter } = await import("../index.js")

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

const testConfig: TelegramConfig = {
  botToken: "test-token-123",
  allowedUsers: new Set([111, 222]),
}

function getHandler(filter: string): Handler {
  const h = messageHandlers.get(filter)
  if (!h) throw new Error(`No handler for ${filter}`)
  return h
}

function makeMessageCtx(userId: number, text: string, chatId = 100) {
  return {
    from: { id: userId, first_name: "Test", last_name: "User", username: "testuser" },
    chat: { id: chatId },
    message: {
      message_id: 42,
      text,
      date: Math.floor(Date.now() / 1000),
      reply_to_message: undefined as { message_id: number } | undefined,
    },
  }
}

function makeCallbackCtx(userId: number, data: string, chatId = 100) {
  return {
    from: { id: userId, first_name: "Test", last_name: "User", username: "testuser" },
    chat: { id: chatId },
    callbackQuery: {
      data,
      message: { message_id: 55 },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  }
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────

describe("TelegramAdapter", () => {
  let adapter: InstanceType<typeof TelegramAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    messageHandlers.clear()
    errorHandler = null
    adapter = new TelegramAdapter(testConfig)
  })

  describe("lifecycle", () => {
    it("has channelType 'telegram'", () => {
      expect(adapter.channelType).toBe("telegram")
    })

    it("start() calls bot.start with correct options", async () => {
      await adapter.start()
      expect(mockStart).toHaveBeenCalledOnce()
      const opts = mockStart.mock.calls[0]![0] as { allowed_updates: string[] }
      expect(opts.allowed_updates).toEqual(["message", "callback_query"])
    })

    it("start() is idempotent", async () => {
      await adapter.start()
      await adapter.start()
      expect(mockStart).toHaveBeenCalledOnce()
    })

    it("stop() calls bot.stop", async () => {
      await adapter.start()
      await adapter.stop()
      expect(mockStop).toHaveBeenCalledOnce()
    })

    it("stop() before start() does nothing", async () => {
      await adapter.stop()
      expect(mockStop).not.toHaveBeenCalled()
    })
  })

  describe("healthCheck", () => {
    it("returns true when getMe succeeds", async () => {
      mockGetMe.mockResolvedValue({ id: 1, is_bot: true, first_name: "Bot" })
      expect(await adapter.healthCheck()).toBe(true)
    })

    it("returns false when getMe throws", async () => {
      mockGetMe.mockRejectedValue(new Error("network error"))
      expect(await adapter.healthCheck()).toBe(false)
    })
  })

  describe("sendMessage", () => {
    it("sends plain text message", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 })

      const msgId = await adapter.sendMessage("123", { text: "Hello" })

      expect(msgId).toBe("99")
      expect(mockSendMessage).toHaveBeenCalledWith("123", "Hello", {
        parse_mode: "HTML",
        reply_parameters: undefined,
        reply_markup: undefined,
      })
    })

    it("sends message with inline buttons", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 100 })

      const msgId = await adapter.sendMessage("123", {
        text: "Choose:",
        inlineButtons: [
          [
            { text: "A", callbackData: "a" },
            { text: "B", callbackData: "b" },
          ],
        ],
      })

      expect(msgId).toBe("100")
      const opts = mockSendMessage.mock.calls[0]![2] as Record<string, unknown>
      expect(opts["reply_markup"]).toBeDefined()
    })

    it("sends message with reply_to", async () => {
      mockSendMessage.mockResolvedValue({ message_id: 101 })

      await adapter.sendMessage("123", { text: "reply", replyToMessageId: "42" })

      const opts = mockSendMessage.mock.calls[0]![2] as Record<string, unknown>
      expect(opts["reply_parameters"]).toEqual({ message_id: 42 })
    })
  })

  describe("sendApprovalRequest", () => {
    it("sends formatted approval with inline keyboard", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-02-24T10:00:00Z"))
      mockSendMessage.mockResolvedValue({ message_id: 200 })

      const notification: ApprovalNotification = {
        jobId: "abcdef12-3456-7890-abcd-ef1234567890",
        agentName: "devops-01",
        actionType: "Deploy to staging",
        actionDetail: "kubectl apply -f deploy/staging/app.yaml",
        approveCallbackData: "apr:a:abcdef1234567890abcdef1234567890",
        rejectCallbackData: "apr:r:abcdef1234567890abcdef1234567890",
        expiresAt: new Date("2026-02-25T10:00:00Z"),
      }

      const msgId = await adapter.sendApprovalRequest("456", notification)

      expect(msgId).toBe("200")
      expect(mockSendMessage).toHaveBeenCalledOnce()

      const callArgs = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>]
      expect(callArgs[0]).toBe("456")
      expect(callArgs[1]).toContain("Approval Required")
      expect(callArgs[1]).toContain("devops-01")
      expect(callArgs[2]["parse_mode"]).toBe("HTML")
      expect(callArgs[2]["reply_markup"]).toBeDefined()

      // Check keyboard has approve, reject, and details buttons
      const markup = callArgs[2]["reply_markup"] as {
        inline_keyboard: { callback_data: string }[][]
      }
      expect(markup.inline_keyboard).toHaveLength(2)
      expect(markup.inline_keyboard[0]).toHaveLength(2)
      expect(markup.inline_keyboard[0]![0]!.callback_data).toBe(
        "apr:a:abcdef1234567890abcdef1234567890",
      )
      expect(markup.inline_keyboard[0]![1]!.callback_data).toBe(
        "apr:r:abcdef1234567890abcdef1234567890",
      )
      expect(markup.inline_keyboard[1]).toHaveLength(1)
      expect(markup.inline_keyboard[1]![0]!.callback_data).toBe(
        "apr:d:abcdef1234567890abcdef1234567890",
      )

      vi.useRealTimers()
    })
  })

  describe("onMessage — user allowlist", () => {
    it("invokes handler for allowed users", async () => {
      const handler = vi.fn<(msg: InboundMessage) => Promise<void>>().mockResolvedValue(undefined)
      adapter.onMessage(handler)

      const messageHandler = getHandler("message:text")
      const ctx = makeMessageCtx(111, "hello")
      await messageHandler(ctx)

      expect(handler).toHaveBeenCalledOnce()
      const msg = handler.mock.calls[0]![0]
      expect(msg.channelType).toBe("telegram")
      expect(msg.channelUserId).toBe("111")
      expect(msg.text).toBe("hello")
      expect(msg.chatId).toBe("100")
    })

    it("ignores messages from disallowed users", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onMessage(handler)

      const messageHandler = getHandler("message:text")
      await messageHandler(makeMessageCtx(999, "hacker"))

      expect(handler).not.toHaveBeenCalled()
    })

    it("allows all users when allowedUsers is empty", async () => {
      const openAdapter = new TelegramAdapter({
        botToken: "test",
        allowedUsers: new Set(),
      })

      const handler = vi.fn().mockResolvedValue(undefined)
      openAdapter.onMessage(handler)

      const messageHandler = messageHandlers.get("message:text")!
      await messageHandler(makeMessageCtx(9999, "anyone"))

      expect(handler).toHaveBeenCalledOnce()
    })

    it("does not crash when no handler is registered", async () => {
      const messageHandler = getHandler("message:text")
      // Should not throw
      await messageHandler(makeMessageCtx(111, "hello"))
    })
  })

  describe("onCallback — inline button handling", () => {
    it("invokes callback handler for allowed users", async () => {
      const handler = vi.fn<(cb: CallbackQuery) => Promise<void>>().mockResolvedValue(undefined)
      adapter.onCallback(handler)

      const cbHandler = getHandler("callback_query:data")
      const ctx = makeCallbackCtx(111, "apr:a:abcdef1234567890abcdef1234567890")
      await cbHandler(ctx)

      expect(handler).toHaveBeenCalledOnce()
      const cb = handler.mock.calls[0]![0]
      expect(cb.channelType).toBe("telegram")
      expect(cb.channelUserId).toBe("111")
      expect(cb.data).toBe("apr:a:abcdef1234567890abcdef1234567890")
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith()
    })

    it("rejects callback from disallowed users", async () => {
      const handler = vi.fn().mockResolvedValue(undefined)
      adapter.onCallback(handler)

      const cbHandler = getHandler("callback_query:data")
      const ctx = makeCallbackCtx(999, "apr:a:0000")
      await cbHandler(ctx)

      expect(handler).not.toHaveBeenCalled()
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "You are not authorized.",
        show_alert: true,
      })
    })

    it("answers callback query even without handler", async () => {
      const cbHandler = getHandler("callback_query:data")
      const ctx = makeCallbackCtx(111, "apr:a:0000")
      await cbHandler(ctx)

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith()
    })

    it("answers with error when handler throws", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("db error"))
      adapter.onCallback(handler)

      const cbHandler = getHandler("callback_query:data")
      const ctx = makeCallbackCtx(111, "apr:a:0000")
      await cbHandler(ctx)

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "An error occurred.",
        show_alert: true,
      })
    })
  })

  describe("error handler", () => {
    it("registers a bot-level error handler", () => {
      expect(errorHandler).not.toBeNull()
    })
  })
})
