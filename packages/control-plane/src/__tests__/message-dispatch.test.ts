import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentChannelService } from "../channels/agent-channel-service.js"
import { createMessageDispatch, watchJobCompletion } from "../channels/message-dispatch.js"
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

function updateChain() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, execute })
  const set = vi.fn().mockReturnValue({ where: whereFn, execute })
  return { set }
}

/**
 * Build a mock Kysely db.
 *
 * selectFrom:
 *   - First call: session lookup (returns existingSession or null → triggers insert)
 *   - Subsequent calls: return selectChain for agent lookup, job polling, etc.
 *
 * insertInto:
 *   - First call: session insert (if no existing session)
 *   - Next call: job insert (returns jobRow)
 */
function mockDb(
  opts: {
    existingSession?: Record<string, unknown> | null
    jobRow?: Record<string, unknown>
  } = {},
) {
  const { existingSession = null, jobRow = { id: "job-123" } } = opts

  // Track selectFrom calls to return session first, then other selects
  const selectFromFn = vi
    .fn()
    .mockImplementation(() => selectChain(existingSession ? [existingSession] : []))

  // Track insertInto calls: session first (if needed), then job
  const insertCalls: ReturnType<typeof insertChain>[] = []
  if (!existingSession) {
    insertCalls.push(insertChain({ id: "new-session-id" }))
  }
  insertCalls.push(insertChain(jobRow))

  let insertCallIndex = 0
  const insertIntoFn = vi.fn().mockImplementation(() => {
    const chain = insertCalls[insertCallIndex] ?? insertChain(jobRow)
    insertCallIndex++
    return chain
  })

  const updateTableFn = vi.fn().mockImplementation(() => updateChain())

  return {
    selectFrom: selectFromFn,
    insertInto: insertIntoFn,
    updateTable: updateTableFn,
  } as unknown as Kysely<Database>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMessageDispatch", () => {
  it("dispatches message to agent with existing session and creates job", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "existing-session-id" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(agentChannelService.resolveAgent).toHaveBeenCalledWith("telegram", "chat-42")

    // Should have inserted a job
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("job")

    // Should have transitioned job to SCHEDULED
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalledWith("job")

    // Should have enqueued the job
    expect(enqueueJob).toHaveBeenCalledWith("job-123")

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-aaa",
        sessionId: "existing-session-id",
        jobId: "job-123",
      }),
      "Chat message dispatched — job created",
    )
  })

  it("creates a new session when none exists and creates job", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: null })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("session")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("job")
    expect(enqueueJob).toHaveBeenCalledWith("job-123")

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-aaa",
        sessionId: "new-session-id",
        jobId: "job-123",
      }),
      "Chat message dispatched — job created",
    )
  })

  it("sends no-agent message when no binding found", async () => {
    const agentChannelService = mockAgentChannelService(null)
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb()

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "No agent is assigned to this chat. Use the dashboard to connect an agent.",
    })
    expect(logger.warn).toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("logs warning but does not throw when enqueueJob fails", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockRejectedValue(new Error("Worker unavailable"))
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    // Should not throw
    await dispatch(makeRoutedMessage())

    expect(enqueueJob).toHaveBeenCalledWith("job-123")
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-123" }),
      "Failed to enqueue job via Graphile Worker",
    )
    // Should still log the dispatch
    expect(logger.info).toHaveBeenCalled()
  })
})

describe("watchJobCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("calls onComplete when job reaches COMPLETED status", async () => {
    const completedResult = { summary: "Done!" }
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
    const db = { selectFrom: selectFn } as unknown as Kysely<Database>

    const onComplete = vi.fn().mockResolvedValue(undefined)
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, { intervalMs: 100 })

    // Advance timers past one interval
    await vi.advanceTimersByTimeAsync(150)

    expect(onComplete).toHaveBeenCalledWith(completedResult)
  })

  it("calls onComplete when job reaches FAILED status", async () => {
    const failedResult = { error: "something broke" }
    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "FAILED",
            result: failedResult,
          }),
        }),
      }),
    })
    const db = { selectFrom: selectFn } as unknown as Kysely<Database>

    const onComplete = vi.fn().mockResolvedValue(undefined)
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, { intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(150)

    expect(onComplete).toHaveBeenCalledWith(failedResult)
  })

  it("keeps polling while job is still RUNNING", async () => {
    let callCount = 0
    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockImplementation(() => {
            callCount++
            if (callCount < 3) {
              return Promise.resolve({ status: "RUNNING", result: null })
            }
            return Promise.resolve({
              status: "COMPLETED",
              result: { summary: "finally done" },
            })
          }),
        }),
      }),
    })
    const db = { selectFrom: selectFn } as unknown as Kysely<Database>

    const onComplete = vi.fn().mockResolvedValue(undefined)
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, { intervalMs: 100 })

    // First two intervals: still running
    await vi.advanceTimersByTimeAsync(250)

    // Third interval: completed
    await vi.advanceTimersByTimeAsync(100)

    expect(onComplete).toHaveBeenCalledWith({ summary: "finally done" })
    expect(callCount).toBe(3)
  })

  it("stops polling on timeout", async () => {
    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue({
            status: "RUNNING",
            result: null,
          }),
        }),
      }),
    })
    const db = { selectFrom: selectFn } as unknown as Kysely<Database>

    const onComplete = vi.fn()
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, {
      intervalMs: 100,
      timeoutMs: 350,
    })

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(500)

    expect(onComplete).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-42" }),
      "Job completion watch timed out",
    )
  })

  it("stops polling when job row is not found", async () => {
    const selectFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    })
    const db = { selectFrom: selectFn } as unknown as Kysely<Database>

    const onComplete = vi.fn()
    const logger = { warn: vi.fn() }

    watchJobCompletion(db, "job-42", onComplete, logger, { intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(150)

    expect(onComplete).not.toHaveBeenCalled()

    // Should have stopped — no further calls on next interval
    await vi.advanceTimersByTimeAsync(200)
    // selectFrom is called once per interval tick, should be exactly 1 call
    expect(selectFn).toHaveBeenCalledTimes(1)
  })
})
