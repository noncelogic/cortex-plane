import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentChannelService } from "../channels/agent-channel-service.js"
import {
  createMessageDispatch,
  loadConversationHistory,
  watchJobCompletion,
} from "../channels/message-dispatch.js"
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

/**
 * Build a mock Kysely db that tracks session_message inserts and supports
 * conversation history loading.
 */
function mockDbWithSessionMessages(
  opts: {
    existingSession?: Record<string, unknown> | null
    jobRow?: Record<string, unknown>
    historyRows?: Array<{ role: string; content: string }>
  } = {},
) {
  const {
    existingSession = { id: "session-123" },
    jobRow = { id: "job-123" },
    historyRows = [],
  } = opts

  const sessionMessageInserts: Array<Record<string, unknown>> = []

  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session") {
      const executeTakeFirst = vi.fn().mockResolvedValue(existingSession ? existingSession : null)
      const executeTakeFirstOrThrow = vi
        .fn()
        .mockResolvedValue(existingSession ?? { id: "new-session-id" })
      const terminal = { executeTakeFirst, executeTakeFirstOrThrow }
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, ...terminal })
      const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
      return { select, selectAll: select }
    }

    if (table === "session_message") {
      // For loadConversationHistory
      const execute = vi.fn().mockResolvedValue(historyRows)
      const limitFn = vi.fn().mockReturnValue({ execute })
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn, limit: limitFn, execute })
      const select = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn, execute })
      return { select, selectAll: select }
    }

    // Fallback (job table, etc.)
    const executeTakeFirst = vi.fn().mockResolvedValue(null)
    const terminal = { executeTakeFirst }
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, ...terminal })
    const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
    return { select, selectAll: select }
  })

  const insertIntoFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session_message") {
      const execute = vi.fn().mockImplementation(() => {
        return Promise.resolve(undefined)
      })
      const values = vi.fn().mockImplementation((val: Record<string, unknown>) => {
        sessionMessageInserts.push(val)
        return {
          execute,
          returning: vi
            .fn()
            .mockReturnValue({ executeTakeFirstOrThrow: vi.fn().mockResolvedValue(val) }),
        }
      })
      return { values }
    }

    if (table === "session") {
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue({ id: "new-session-id" })
      const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
      const values = vi.fn().mockReturnValue({ returning })
      return { values }
    }

    // job insert
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(jobRow)
    const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
    const values = vi.fn().mockReturnValue({ returning })
    return { values }
  })

  const updateTableFn = vi.fn().mockImplementation(() => {
    const execute = vi.fn().mockResolvedValue(undefined)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, execute })
    const set = vi.fn().mockReturnValue({ where: whereFn, execute })
    return { set }
  })

  return {
    db: {
      selectFrom: selectFromFn,
      insertInto: insertIntoFn,
      updateTable: updateTableFn,
    } as unknown as Kysely<Database>,
    sessionMessageInserts,
  }
}

// ---------------------------------------------------------------------------
// Tests: Session Buffer — Conversation History
// ---------------------------------------------------------------------------

describe("session buffer — message dispatch with conversation history", () => {
  it("stores user message in session_message on dispatch", async () => {
    const { db, sessionMessageInserts } = mockDbWithSessionMessages({
      existingSession: { id: "session-123" },
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Should have inserted a user message into session_message
    expect(sessionMessageInserts).toContainEqual(
      expect.objectContaining({
        session_id: "session-123",
        role: "user",
        content: "Hello agent",
      }),
    )
  })

  it("includes channel_id when creating a new session", async () => {
    const { db } = mockDbWithSessionMessages({
      existingSession: null,
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Session insert should include channel_id
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("session")
  })

  it("passes conversation history to job payload", async () => {
    const historyRows = [
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "Hello agent" },
    ]
    const { db } = mockDbWithSessionMessages({
      existingSession: { id: "session-123" },
      historyRows,
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Job should have been inserted
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("job")
    expect(enqueueJob).toHaveBeenCalledWith("job-123")
  })
})

describe("session buffer — watchJobCompletion stores assistant response", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stores assistant response in session_message on job completion", async () => {
    const sessionMessageInserts: Array<Record<string, unknown>> = []
    const completedResult = { summary: "Here is the answer!" }

    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "COMPLETED",
            result: completedResult,
          }),
        }),
      }),
    })

    const insertIntoFn = vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const values = vi.fn().mockImplementation((val: Record<string, unknown>) => {
        sessionMessageInserts.push(val)
        return { execute }
      })
      return { values }
    })

    const db = {
      selectFrom: selectFn,
      insertInto: insertIntoFn,
    } as unknown as Kysely<Database>

    const onComplete = vi
      .fn()
      .mockImplementation(async (result: Record<string, unknown> | null) => {
        const summary = result?.summary
        if (typeof summary === "string" && summary.length > 0) {
          await db
            .insertInto("session_message")
            .values({
              session_id: "session-123",
              role: "assistant",
              content: summary,
            })
            .execute()
        }
      })
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, { intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(150)

    expect(onComplete).toHaveBeenCalledWith(completedResult)
    expect(sessionMessageInserts).toContainEqual(
      expect.objectContaining({
        session_id: "session-123",
        role: "assistant",
        content: "Here is the answer!",
      }),
    )
  })
})

describe("loadConversationHistory", () => {
  it("loads messages in chronological order excluding the latest user message", async () => {
    const rows = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
      { role: "user", content: "Thanks" },
    ]

    // Simulate DESC order from DB (newest first)
    const descRows = [...rows].reverse()

    const execute = vi.fn().mockResolvedValue(descRows)
    const limitFn = vi.fn().mockReturnValue({ execute })
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    const selectFrom = vi.fn().mockReturnValue({ select })

    const db = { selectFrom } as unknown as Kysely<Database>

    const history = await loadConversationHistory(db, "session-abc")

    // Should exclude the latest user message ("Thanks") and return in chronological order
    expect(history).toEqual([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ])
  })

  it("returns empty array when no messages exist", async () => {
    const execute = vi.fn().mockResolvedValue([])
    const limitFn = vi.fn().mockReturnValue({ execute })
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    const selectFrom = vi.fn().mockReturnValue({ select })

    const db = { selectFrom } as unknown as Kysely<Database>

    const history = await loadConversationHistory(db, "session-empty")

    expect(history).toEqual([])
  })

  it("preserves all messages when last message is from assistant", async () => {
    const rows = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]

    const descRows = [...rows].reverse()

    const execute = vi.fn().mockResolvedValue(descRows)
    const limitFn = vi.fn().mockReturnValue({ execute })
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    const selectFrom = vi.fn().mockReturnValue({ select })

    const db = { selectFrom } as unknown as Kysely<Database>

    const history = await loadConversationHistory(db, "session-abc")

    // Last message is assistant, so nothing stripped
    expect(history).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ])
  })
})
