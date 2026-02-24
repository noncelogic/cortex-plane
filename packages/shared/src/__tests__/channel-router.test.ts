import { describe, expect, it, vi } from "vitest"

import type { ResolvedUser, RouterDb } from "../channels/router.js"
import { MessageRouter } from "../channels/router.js"
import type { ChannelAdapter, InboundMessage } from "../channels/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function createMockAdapter(type: string): ChannelAdapter {
  return {
    channelType: type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue("sent-msg-id"),
    sendApprovalRequest: vi.fn().mockResolvedValue("sent-approval-id"),
    onMessage: vi.fn(),
  }
}

function createMockDb(existingUser?: ResolvedUser): RouterDb {
  return {
    resolveUser: vi.fn().mockResolvedValue(existingUser),
    createUser: vi.fn().mockResolvedValue({
      userAccountId: "new-user-id",
      channelMappingId: "new-mapping-id",
    } satisfies ResolvedUser),
  }
}

function makeInbound(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    channelType: "telegram",
    channelUserId: "tg-user-123",
    chatId: "tg-chat-456",
    messageId: "msg-789",
    text: "Hello agent",
    timestamp: new Date("2026-02-24T12:00:00Z"),
    metadata: {},
    ...overrides,
  }
}

// ──────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────

describe("MessageRouter", () => {
  describe("route — existing user", () => {
    it("resolves an existing user and invokes the handler", async () => {
      const existing: ResolvedUser = {
        userAccountId: "user-abc",
        channelMappingId: "mapping-def",
      }
      const db = createMockDb(existing)
      const adapters = new Map([["telegram", createMockAdapter("telegram")]])
      const router = new MessageRouter(db, adapters)

      const handler = vi.fn().mockResolvedValue(undefined)
      router.onMessage(handler)

      const msg = makeInbound()
      await router.route(msg)

      expect(db.resolveUser).toHaveBeenCalledWith("telegram", "tg-user-123")
      expect(db.createUser).not.toHaveBeenCalled()
      expect(handler).toHaveBeenCalledWith({
        userAccountId: "user-abc",
        channelMappingId: "mapping-def",
        message: msg,
      })
    })
  })

  describe("route — new user (auto-provision)", () => {
    it("creates a user_account when resolveUser returns undefined", async () => {
      const db = createMockDb(undefined)
      const adapters = new Map([["telegram", createMockAdapter("telegram")]])
      const router = new MessageRouter(db, adapters)

      const handler = vi.fn().mockResolvedValue(undefined)
      router.onMessage(handler)

      const msg = makeInbound()
      await router.route(msg)

      expect(db.resolveUser).toHaveBeenCalledWith("telegram", "tg-user-123")
      expect(db.createUser).toHaveBeenCalledWith("telegram", "tg-user-123", null)
      expect(handler).toHaveBeenCalledWith({
        userAccountId: "new-user-id",
        channelMappingId: "new-mapping-id",
        message: msg,
      })
    })
  })

  describe("route — no handler", () => {
    it("throws if no handler is registered", async () => {
      const db = createMockDb()
      const adapters = new Map<string, ChannelAdapter>()
      const router = new MessageRouter(db, adapters)

      await expect(router.route(makeInbound())).rejects.toThrow("No message handler registered")
    })
  })

  describe("send", () => {
    it("delegates to the correct adapter's sendMessage", async () => {
      const db = createMockDb()
      const tg = createMockAdapter("telegram")
      const adapters = new Map([["telegram", tg]])
      const router = new MessageRouter(db, adapters)

      const result = await router.send("telegram", "chat-1", { text: "Hi" })

      expect(tg.sendMessage).toHaveBeenCalledWith("chat-1", { text: "Hi" })
      expect(result).toBe("sent-msg-id")
    })

    it("throws if no adapter for the channel type", async () => {
      const db = createMockDb()
      const adapters = new Map<string, ChannelAdapter>()
      const router = new MessageRouter(db, adapters)

      await expect(router.send("whatsapp", "chat-1", { text: "Hi" })).rejects.toThrow(
        "No adapter registered for channel type 'whatsapp'",
      )
    })
  })

  describe("bind", () => {
    it("registers the route handler on each adapter's onMessage", () => {
      const db = createMockDb()
      const tg = createMockAdapter("telegram")
      const dc = createMockAdapter("discord")
      const adapters = new Map([
        ["telegram", tg],
        ["discord", dc],
      ])
      const router = new MessageRouter(db, adapters)
      router.onMessage(vi.fn().mockResolvedValue(undefined))

      router.bind()

      expect(tg.onMessage).toHaveBeenCalledOnce()
      expect(dc.onMessage).toHaveBeenCalledOnce()
    })
  })
})
