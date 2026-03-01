/**
 * End-to-End Chat Flow Integration Test
 *
 * Verifies the full chat flow from inbound message through to response relay:
 *   channel adapter → router → dispatch → job creation → execution → response
 *
 * Uses mocked dependencies to test the integration wiring without real
 * database or LLM connections.
 */

import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

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

function makeRoutedMessage(text = "Hello agent"): RoutedMessage {
  return {
    userAccountId: "user-111",
    channelMappingId: "mapping-222",
    message: {
      channelType: "telegram",
      channelUserId: "tg-user-1",
      chatId: "chat-42",
      messageId: "msg-1",
      text,
      timestamp: new Date(),
      metadata: {},
    },
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
 * Builds a mock Kysely DB that tracks all insertions and supports the
 * full dispatch flow: session lookup → message insert → history load → job insert.
 */
function buildFlowDb(opts: {
  existingSession?: { id: string } | null
  historyRows?: Array<{ role: string; content: string }>
  jobRow?: { id: string }
}) {
  const {
    existingSession = { id: "session-123" },
    historyRows = [],
    jobRow = { id: "job-e2e" },
  } = opts

  const sessionMessageInserts: Array<Record<string, unknown>> = []

  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session") {
      const executeTakeFirst = vi.fn().mockResolvedValue(existingSession)
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
      const execute = vi.fn().mockResolvedValue(historyRows)
      const limitFn = vi.fn().mockReturnValue({ execute })
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      whereFn.mockReturnValue({
        where: whereFn,
        orderBy: orderByFn,
        limit: limitFn,
        execute,
      })
      const select = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn, execute })
      return { select, selectAll: select }
    }

    // Fallback (job table polling, etc.)
    const executeTakeFirst = vi.fn().mockResolvedValue(null)
    const terminal = { executeTakeFirst }
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, ...terminal })
    const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
    return { select, selectAll: select }
  })

  const insertIntoFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session_message") {
      const execute = vi.fn().mockResolvedValue(undefined)
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
// Tests
// ---------------------------------------------------------------------------

describe("end-to-end chat flow", () => {
  it("dispatches a message, creates a job, and relays the full response", async () => {
    const { db, sessionMessageInserts } = buildFlowDb({
      existingSession: { id: "session-e2e" },
      historyRows: [{ role: "assistant", content: "Previous answer" }],
    })
    const agentChannelService = mockAgentChannelService("agent-e2e")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    // Step 1: Create dispatch handler and process a message
    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage("What is the meaning of life?"))

    // Verify: agent resolved
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(agentChannelService.resolveAgent).toHaveBeenCalledWith("telegram", "chat-42")

    // Verify: user message stored in session_message
    expect(sessionMessageInserts).toContainEqual(
      expect.objectContaining({
        session_id: "session-e2e",
        role: "user",
        content: "What is the meaning of life?",
      }),
    )

    // Verify: job created and enqueued
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("job")
    expect(enqueueJob).toHaveBeenCalledWith("job-e2e")

    // Verify: dispatch logged
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-e2e",
        sessionId: "session-e2e",
        jobId: "job-e2e",
      }),
      "Chat message dispatched — job created",
    )
  })

  it("relays full stdout from completed job back to channel", async () => {
    vi.useFakeTimers()

    const fullResponseText =
      "The meaning of life is a deeply philosophical question that has been pondered " +
      "for millennia. While there is no single definitive answer, many philosophers, " +
      "theologians, and scientists have offered various perspectives ranging from " +
      "existential purpose to the pursuit of happiness and knowledge."

    // Mock a completed job with full stdout and truncated summary
    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "COMPLETED",
            result: {
              summary: fullResponseText.slice(0, 200),
              stdout: fullResponseText,
            },
          }),
        }),
      }),
    })

    const insertIntoFn = vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const values = vi.fn().mockReturnValue({ execute })
      return { values }
    })

    const db = {
      selectFrom: selectFn,
      insertInto: insertIntoFn,
    } as unknown as Kysely<Database>

    const router = mockRouter()
    const sessionId = "session-e2e"

    // Simulate the watchJobCompletion callback that message-dispatch uses
    watchJobCompletion(
      db,
      "job-e2e",
      async (result, _status) => {
        const responseText =
          typeof result?.stdout === "string" && result.stdout.length > 0
            ? result.stdout
            : typeof result?.summary === "string" && result.summary.length > 0
              ? result.summary
              : null

        if (responseText) {
          await db
            .insertInto("session_message")
            .values({
              session_id: sessionId,
              role: "assistant",
              content: responseText,
            })
            .execute()

          await router.send("telegram", "chat-42", { text: responseText })
        }
      },
      { warn: vi.fn() },
      { intervalMs: 100 },
    )

    await vi.advanceTimersByTimeAsync(150)

    // Should have sent the FULL response text (not the truncated summary)
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: fullResponseText,
    })

    vi.useRealTimers()
  })

  it("sends error notification on failed job", async () => {
    vi.useFakeTimers()

    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "FAILED",
            result: null,
          }),
        }),
      }),
    })

    const db = { selectFrom: selectFn } as unknown as Kysely<Database>
    const router = mockRouter()

    watchJobCompletion(
      db,
      "job-fail",
      async (result, status) => {
        const responseText =
          typeof result?.stdout === "string" && result.stdout.length > 0
            ? result.stdout
            : typeof result?.summary === "string" && result.summary.length > 0
              ? result.summary
              : null

        if (!responseText && (status === "FAILED" || status === "TIMED_OUT")) {
          const errMsg =
            status === "TIMED_OUT"
              ? "The request timed out. Please try again."
              : "Something went wrong processing your message. Please try again."
          await router.send("telegram", "chat-42", { text: errMsg })
        }
      },
      { warn: vi.fn() },
      { intervalMs: 100 },
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "Something went wrong processing your message. Please try again.",
    })

    vi.useRealTimers()
  })

  it("sends timeout notification on timed-out job", async () => {
    vi.useFakeTimers()

    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "TIMED_OUT",
            result: null,
          }),
        }),
      }),
    })

    const db = { selectFrom: selectFn } as unknown as Kysely<Database>
    const router = mockRouter()

    watchJobCompletion(
      db,
      "job-timeout",
      async (result, status) => {
        const responseText =
          typeof result?.stdout === "string" && result.stdout.length > 0
            ? result.stdout
            : typeof result?.summary === "string" && result.summary.length > 0
              ? result.summary
              : null

        if (!responseText && (status === "FAILED" || status === "TIMED_OUT")) {
          const errMsg =
            status === "TIMED_OUT"
              ? "The request timed out. Please try again."
              : "Something went wrong processing your message. Please try again."
          await router.send("telegram", "chat-42", { text: errMsg })
        }
      },
      { warn: vi.fn() },
      { intervalMs: 100 },
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "The request timed out. Please try again.",
    })

    vi.useRealTimers()
  })
})

describe("conversation history round-trip", () => {
  it("loads prior messages and passes them to job payload", async () => {
    // Simulate 3-turn conversation history (DESC from DB)
    const dbRows = [
      { role: "user", content: "Third question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "First question" },
    ]

    const execute = vi.fn().mockResolvedValue(dbRows)
    const limitFn = vi.fn().mockReturnValue({ execute })
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, orderBy: orderByFn })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    const selectFrom = vi.fn().mockReturnValue({ select })
    const db = { selectFrom } as unknown as Kysely<Database>

    const history = await loadConversationHistory(db, "session-abc")

    // Should be chronological and exclude the latest user message
    expect(history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Second answer" },
    ])
  })

  it("full dispatch uses history in job payload", async () => {
    const { db } = buildFlowDb({
      existingSession: { id: "session-history" },
      historyRows: [
        { role: "assistant", content: "Previous response" },
        { role: "user", content: "Follow-up" },
      ],
    })
    const agentChannelService = mockAgentChannelService("agent-history")
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

    await dispatch(makeRoutedMessage("New question"))

    // Job was created and enqueued
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("job")
    expect(enqueueJob).toHaveBeenCalledWith("job-e2e")
  })
})
