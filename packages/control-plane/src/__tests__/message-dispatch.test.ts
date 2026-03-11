import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthDecision, ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { RateLimitDecision, UserRateLimiter } from "../auth/user-rate-limiter.js"
import type { AgentChannelService } from "../channels/agent-channel-service.js"
import { createMessageDispatch, watchJobCompletion } from "../channels/message-dispatch.js"
import type { PreflightResult } from "../channels/preflight.js"
import type { Database } from "../db/types.js"
import type { AgentEventEmitter } from "../observability/event-emitter.js"

// ---------------------------------------------------------------------------
// Preflight mock
// ---------------------------------------------------------------------------

const mockRunPreflight = vi.hoisted(() => vi.fn())
const mockMapJobErrorToUserMessage = vi.hoisted(() => vi.fn())

vi.mock("../channels/preflight.js", () => ({
  runPreflight: mockRunPreflight,
  mapJobErrorToUserMessage: mockMapJobErrorToUserMessage,
}))

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
  const execute = vi.fn().mockResolvedValue(rows)
  const limitFn = vi.fn().mockReturnValue({ execute })
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn, execute })
  const terminal = {
    executeTakeFirst,
    executeTakeFirstOrThrow,
    orderBy: orderByFn,
    limit: limitFn,
    execute,
  }
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, ...terminal })
  const selectAll = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  return { selectAll, select, returning }
}

function insertChain(row: Record<string, unknown>) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(row)
  const execute = vi.fn().mockResolvedValue(undefined)
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  const values = vi.fn().mockReturnValue({ returning, execute })
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

  // Track insertInto calls: session (if needed), session_message, then job
  const insertCalls: ReturnType<typeof insertChain>[] = []
  if (!existingSession) {
    insertCalls.push(insertChain({ id: "new-session-id" }))
  }
  insertCalls.push(insertChain({})) // session_message insert
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

function mockChannelAuthGuard(decision: AuthDecision) {
  return {
    authorize: vi.fn().mockResolvedValue(decision),
    handlePairingCode: vi.fn().mockResolvedValue({
      success: true,
      message: "Pairing code accepted.",
    }),
    resolveOrCreateIdentity: vi.fn(),
  } as unknown as ChannelAuthGuard
}

function mockUserRateLimiter(decision: RateLimitDecision) {
  return {
    check: vi.fn().mockResolvedValue(decision),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    getUsageSummary: vi.fn(),
  } as unknown as UserRateLimiter
}

function mockEventEmitter() {
  return {
    emit: vi.fn().mockResolvedValue({ eventId: "evt-1" }),
    emitStart: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentEventEmitter
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMessageDispatch", () => {
  beforeEach(() => {
    mockRunPreflight.mockResolvedValue({ ok: true } as PreflightResult)
    mockMapJobErrorToUserMessage.mockReturnValue(
      "Something went wrong processing your message. Please try again.",
    )
  })

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

    expect(onComplete).toHaveBeenCalledWith(completedResult, "COMPLETED")
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

    expect(onComplete).toHaveBeenCalledWith(failedResult, "FAILED")
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

    expect(onComplete).toHaveBeenCalledWith({ summary: "finally done" }, "COMPLETED")
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

describe("ChannelAuthGuard integration", () => {
  it("blocks message when guard denies access and sends rejection reply", async () => {
    const guard = mockChannelAuthGuard({
      allowed: false,
      userId: "user-111",
      reason: "denied",
      replyToUser: "This agent is private. Ask an operator for a pairing code.",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Guard was called (channelConfigId comes from the mock db's selectFrom("channel_config"))
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-aaa",
        channelType: "telegram",
        channelUserId: "tg-user-1",
        chatId: "chat-42",
        messageText: "Hello agent",
      }),
    )

    // Rejection message sent
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "This agent is private. Ask an operator for a pairing code.",
    })

    // No job created
    expect(enqueueJob).not.toHaveBeenCalled()

    // Blocked log entry
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "denied" }),
      "Message blocked by ChannelAuthGuard",
    )
  })

  it("blocks message when guard returns pending_approval", async () => {
    const guard = mockChannelAuthGuard({
      allowed: false,
      userId: "user-111",
      reason: "pending_approval",
      replyToUser: "Your request has been submitted. You'll be notified when approved.",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "Your request has been submitted. You'll be notified when approved.",
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("allows message through when guard grants access", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      grantId: "grant-999",
      reason: "granted",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Job was created and enqueued
    expect(enqueueJob).toHaveBeenCalledWith("job-123")

    // Dispatch logged (not blocked)
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-123" }),
      "Chat message dispatched — job created",
    )
  })

  it("intercepts pairing codes and calls handlePairingCode", async () => {
    const guard = mockChannelAuthGuard({
      allowed: false,
      userId: "user-111",
      reason: "denied",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      logger,
    })

    // Send a 6-char uppercase alphanumeric code
    await dispatch(
      makeRoutedMessage({
        message: {
          channelType: "telegram",
          channelUserId: "tg-user-1",
          chatId: "chat-42",
          messageId: "msg-1",
          text: "ABC123",
          timestamp: new Date(),
          metadata: {},
        },
      }),
    )

    // handlePairingCode was called instead of authorize
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.handlePairingCode).toHaveBeenCalledWith("ABC123", "mapping-222", "user-111")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.authorize).not.toHaveBeenCalled()

    // Pairing result relayed to user
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "Pairing code accepted.",
    })

    // No job created
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("does not intercept non-pairing-code text as pairing code", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      reason: "granted",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      logger,
    })

    // Regular text, not a pairing code
    await dispatch(makeRoutedMessage())

    // authorize called, not handlePairingCode
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.authorize).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(guard.handlePairingCode).not.toHaveBeenCalled()
    expect(enqueueJob).toHaveBeenCalled()
  })

  it("emits message_denied event when guard denies access", async () => {
    const guard = mockChannelAuthGuard({
      allowed: false,
      userId: "user-111",
      reason: "denied",
      replyToUser: "This agent is private.",
    })
    const emitter = mockEventEmitter()
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      eventEmitter: emitter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(emitter.emit).toHaveBeenCalledWith({
      agentId: "agent-aaa",
      eventType: "message_denied",
      actor: "system",
      payload: {
        reason: "denied",
        channelType: "telegram",
        chatId: "chat-42",
        userId: "user-111",
      },
    })
  })

  it("does not emit event when no eventEmitter provided", async () => {
    const guard = mockChannelAuthGuard({
      allowed: false,
      userId: "user-111",
      reason: "denied",
      replyToUser: "Private.",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      // no eventEmitter
      logger,
    })

    // Should not throw
    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalled()
  })

  it("skips guard when channelAuthGuard is not provided", async () => {
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      // No channelAuthGuard
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Job created normally without guard
    expect(enqueueJob).toHaveBeenCalledWith("job-123")
  })
})

describe("UserRateLimiter integration", () => {
  it("blocks message when user exceeds rate limit", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      grantId: "grant-999",
      reason: "granted",
    })
    const rateLimiter = mockUserRateLimiter({
      allowed: false,
      reason: "rate_limited",
      replyToUser: "You've reached the message limit (60 per hour). Please try again later.",
      retryAfterSeconds: 3600,
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      userRateLimiter: rateLimiter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Rate limit reply sent
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "You've reached the message limit (60 per hour). Please try again later.",
    })

    // No job created
    expect(enqueueJob).not.toHaveBeenCalled()

    // Blocked log entry
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "rate_limited" }),
      "Message blocked by rate limiter",
    )
  })

  it("blocks message when user exceeds token budget", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      grantId: "grant-999",
      reason: "granted",
    })
    const rateLimiter = mockUserRateLimiter({
      allowed: false,
      reason: "budget_exceeded",
      replyToUser:
        "You've reached the token budget (100000 tokens per day). Please try again later.",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      userRateLimiter: rateLimiter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: "You've reached the token budget (100000 tokens per day). Please try again later.",
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("emits message_denied event when rate limit exceeded", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      grantId: "grant-999",
      reason: "granted",
    })
    const rateLimiter = mockUserRateLimiter({
      allowed: false,
      reason: "rate_limited",
      replyToUser: "Rate limited.",
      retryAfterSeconds: 3600,
    })
    const emitter = mockEventEmitter()
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      userRateLimiter: rateLimiter,
      eventEmitter: emitter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(emitter.emit).toHaveBeenCalledWith({
      agentId: "agent-aaa",
      eventType: "message_denied",
      actor: "system",
      payload: {
        reason: "rate_limited",
        channelType: "telegram",
        chatId: "chat-42",
        userId: "user-111",
      },
    })
  })

  it("allows message through when rate limiter approves", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      grantId: "grant-999",
      reason: "granted",
    })
    const rateLimiter = mockUserRateLimiter({
      allowed: true,
      reason: "allowed",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      userRateLimiter: rateLimiter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Job created
    expect(enqueueJob).toHaveBeenCalledWith("job-123")

    // Rate limiter was called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rateLimiter.check).toHaveBeenCalledWith("user-111", "agent-aaa", undefined, undefined)
  })

  it("skips rate limiting when no auth guard is provided", async () => {
    const rateLimiter = mockUserRateLimiter({
      allowed: false,
      reason: "rate_limited",
      replyToUser: "Rate limited",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      // No channelAuthGuard — rate limiter should be skipped
      userRateLimiter: rateLimiter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Rate limiter never called (no auth decision)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rateLimiter.check).not.toHaveBeenCalled()

    // Job still created
    expect(enqueueJob).toHaveBeenCalledWith("job-123")
  })

  it("skips rate limiting when auth grants without grantId", async () => {
    const guard = mockChannelAuthGuard({
      allowed: true,
      userId: "user-111",
      // No grantId — e.g. guard is permissive
      reason: "granted",
    })
    const rateLimiter = mockUserRateLimiter({
      allowed: false,
      reason: "rate_limited",
      replyToUser: "Rate limited",
    })
    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      channelAuthGuard: guard,
      userRateLimiter: rateLimiter,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Rate limiter skipped — no grantId means no per-user limits apply
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(rateLimiter.check).not.toHaveBeenCalled()

    // Job created
    expect(enqueueJob).toHaveBeenCalledWith("job-123")
  })
})

describe("Preflight check integration", () => {
  beforeEach(() => {
    mockRunPreflight.mockResolvedValue({ ok: true } as PreflightResult)
    mockMapJobErrorToUserMessage.mockReturnValue(
      "Something went wrong processing your message. Please try again.",
    )
  })

  it("blocks message and sends actionable reply when agent is quarantined", async () => {
    mockRunPreflight.mockResolvedValue({
      ok: false,
      code: "agent_not_active",
      userMessage:
        "This agent is temporarily quarantined due to repeated failures. " +
        "An operator can reset it from the agent dashboard.",
    } as PreflightResult)

    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    // Actionable message sent
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: expect.stringContaining("quarantined") as string,
    })

    // No job created
    expect(enqueueJob).not.toHaveBeenCalled()

    // Warning logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent_not_active" }),
      "Preflight check failed — agent not ready for dispatch",
    )
  })

  it("blocks message and sends actionable reply when LLM credential is missing", async () => {
    mockRunPreflight.mockResolvedValue({
      ok: false,
      code: "no_llm_credential",
      userMessage:
        "This agent does not have an LLM API key configured. " +
        "An operator needs to bind an LLM credential in the agent settings.",
    } as PreflightResult)

    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: expect.stringContaining("LLM API key") as string,
    })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it("skips preflight when no agent is bound (handled before preflight)", async () => {
    mockRunPreflight.mockClear()
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

    // Preflight never called — no agent to check
    expect(mockRunPreflight).not.toHaveBeenCalled()

    // No-agent message sent
    expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
      text: expect.stringContaining("No agent is assigned") as string,
    })
  })

  it("proceeds normally when preflight passes", async () => {
    mockRunPreflight.mockResolvedValue({ ok: true } as PreflightResult)

    const agentChannelService = mockAgentChannelService("agent-aaa")
    const router = mockRouter()
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }
    const db = mockDb({ existingSession: { id: "session-1" } })

    const dispatch = createMessageDispatch({
      db,
      agentChannelService,
      router: router as never,
      enqueueJob,
      logger,
    })

    await dispatch(makeRoutedMessage())

    expect(mockRunPreflight).toHaveBeenCalledWith(db, "agent-aaa")
    expect(enqueueJob).toHaveBeenCalledWith("job-123")
  })
})
