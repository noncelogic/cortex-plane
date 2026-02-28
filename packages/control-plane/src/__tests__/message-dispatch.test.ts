import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { AgentChannelService } from "../channels/agent-channel-service.js"
import { createMessageDispatch } from "../channels/message-dispatch.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutedMessage(overrides: Partial<RoutedMessage> = {}): RoutedMessage {
  return {
    userAccountId: "user-111",
    channelMappingId: "mapping-222",
    message: {
      channelType: "telegram",
      channelUserId: "tg-user-1",
      chatId: "chat-42",
      messageId: "msg-1",
      text: "Hello agent",
      timestamp: new Date(),
      metadata: {},
    },
    ...overrides,
  }
}

function mockAgentChannelService(agentId: string | null = "agent-aaa") {
  return {
    resolveAgent: vi.fn().mockResolvedValue(agentId),
    bindChannel: vi.fn(),
    unbindChannel: vi.fn(),
    unbindById: vi.fn(),
    listBindings: vi.fn(),
    setDefault: vi.fn(),
  } as unknown as AgentChannelService
}

function mockRouter() {
  return {
    send: vi.fn().mockResolvedValue("sent-msg-id"),
  }
}

function selectChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(rows[0])
  const terminal = { executeTakeFirst, executeTakeFirstOrThrow }
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, ...terminal })
  const selectAll = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  return { selectAll, select, returning }
}

function insertChain(row: Record<string, unknown>) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(row)
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  const values = vi.fn().mockReturnValue({ returning })
  return { values }
}

function mockDb(opts: { existingSession?: Record<string, unknown> | null } = {}) {
  const { existingSession = null } = opts
  return {
    selectFrom: vi
      .fn()
      .mockImplementation(() => selectChain(existingSession ? [existingSession] : [])),
    insertInto: vi.fn().mockImplementation(() => insertChain({ id: "new-session-id" })),
  } as unknown as Kysely<Database>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMessageDispatch", () => {
  it("dispatches message to agent with existing session", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "existing-session-id" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(agentChannelService.resolveAgent).toHaveBeenCalledWith("telegram", "chat-42")
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-aaa",
        sessionId: "existing-session-id",
      }),
      "Message dispatched to agent session",
    )
    expect(router.send).not.toHaveBeenCalled()
  })

  it("creates a new session when none exists", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: null })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("session")
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-aaa",
        sessionId: "new-session-id",
      }),
      "Message dispatched to agent session",
    )
  })

  it("sends no-agent message when no binding found", async () => {
    const agentChannelService = mockAgentChannelService(null)
    const router = mockRouter()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb()

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "No agent is assigned to this chat. Use the dashboard to connect an agent.",
    })
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
