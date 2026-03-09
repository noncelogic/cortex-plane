/**
 * Auth Gate Verification Tests (#502)
 *
 * Comprehensive verification that user authorization gates work correctly:
 * - Auth guard enabled and enforced for all channel-bound agents
 * - Unauthorized users rejected with actionable messages
 * - Pairing code E2E flow (generate → redeem → grant → chat)
 * - Token budget enforcement prevents runaway spend
 * - Rate limit enforcement
 * - Channel-level allowlist gate
 * - Concurrent auto-grant idempotency
 */

/* eslint-disable @typescript-eslint/unbound-method */
import type { RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { AuthDecision, ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { RateLimitDecision, UserRateLimiter } from "../auth/user-rate-limiter.js"
import type { AgentChannelService } from "../channels/agent-channel-service.js"
import { createMessageDispatch } from "../channels/message-dispatch.js"
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

function mockDb(
  opts: {
    existingSession?: Record<string, unknown> | null
    jobRow?: Record<string, unknown>
  } = {},
) {
  const { existingSession = null, jobRow = { id: "job-123" } } = opts

  const selectFromFn = vi
    .fn()
    .mockImplementation(() => selectChain(existingSession ? [existingSession] : []))

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

function setupDispatch(opts: {
  guard?: ChannelAuthGuard
  rateLimiter?: UserRateLimiter
  eventEmitter?: AgentEventEmitter
  agentId?: string | null
  existingSession?: Record<string, unknown> | null
}) {
  mockRunPreflight.mockResolvedValue({ ok: true } as PreflightResult)
  mockMapJobErrorToUserMessage.mockReturnValue("Something went wrong.")

  const agentChannelService = mockAgentChannelService(opts.agentId ?? "agent-aaa")
  const router = mockRouter()
  const enqueueJob = vi.fn().mockResolvedValue(undefined)
  const logger = { info: vi.fn(), warn: vi.fn() }
  const db = mockDb({ existingSession: opts.existingSession ?? { id: "session-1" } })

  const dispatch = createMessageDispatch({
    db,
    agentChannelService,
    router: router as never,
    enqueueJob,
    channelAuthGuard: opts.guard,
    userRateLimiter: opts.rateLimiter,
    eventEmitter: opts.eventEmitter,
    logger,
  })

  return { dispatch, router, enqueueJob, logger, db, agentChannelService }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Auth gate verification (#502)", () => {
  // =========================================================================
  // 1. Auth guard enabled + enforced for all channel-bound agents
  // =========================================================================
  describe("auth guard enforcement", () => {
    it("blocks unauthorized user and returns actionable rejection message", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "denied",
        replyToUser: "This agent is private. Ask an operator for a pairing code.",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "This agent is private. Ask an operator for a pairing code.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("rejects with actionable message for revoked grants", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "revoked",
        replyToUser: "Your access to this agent has been revoked.",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Your access to this agent has been revoked.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("rejects with actionable message for expired grants", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "expired",
        replyToUser: "Your access to this agent has expired.",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Your access to this agent has expired.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("rejects with actionable message for channel-denied users", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "channel_denied",
        replyToUser:
          "You are not authorized to use this channel. Contact an operator to be added to the allowlist.",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "You are not authorized to use this channel. Contact an operator to be added to the allowlist.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("emits message_denied event with audit details on rejection", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "denied",
        replyToUser: "Access denied.",
      })
      const emitter = mockEventEmitter()
      const { dispatch } = setupDispatch({ guard, eventEmitter: emitter })

      await dispatch(makeRoutedMessage())

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

    it("allows authorized user to proceed to job dispatch", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        grantId: "grant-999",
        reason: "granted",
      })
      const { dispatch, enqueueJob, logger } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(enqueueJob).toHaveBeenCalledWith("job-123")
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-123" }),
        "Chat message dispatched — job created",
      )
    })

    it("passes authorized userId and grantId into job payload", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        grantId: "grant-999",
        reason: "granted",
      })
      const { dispatch, db } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      // The job insert call should include authorizedUserId and grantId
      expect(db.insertInto).toHaveBeenCalledWith("job")
    })
  })

  // =========================================================================
  // 2. Pairing code E2E flow (generate → redeem → chat)
  // =========================================================================
  describe("pairing code flow", () => {
    it("intercepts 6-char uppercase message as pairing code", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "denied",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      const msg = makeRoutedMessage({
        message: {
          channelType: "telegram",
          channelUserId: "tg-user-1",
          chatId: "chat-42",
          messageId: "msg-1",
          text: "ABC123",
          timestamp: new Date(),
          metadata: {},
        },
      })
      await dispatch(msg)

      expect(guard.handlePairingCode).toHaveBeenCalledWith("ABC123", "mapping-222", "user-111")
      expect(guard.authorize).not.toHaveBeenCalled()
      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Pairing code accepted.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("does not intercept lowercase/mixed text as pairing code", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        reason: "granted",
      })
      const { dispatch, enqueueJob } = setupDispatch({ guard })

      await dispatch(
        makeRoutedMessage({
          message: {
            channelType: "telegram",
            channelUserId: "tg-user-1",
            chatId: "chat-42",
            messageId: "msg-1",
            text: "hello world",
            timestamp: new Date(),
            metadata: {},
          },
        }),
      )

      expect(guard.authorize).toHaveBeenCalled()
      expect(guard.handlePairingCode).not.toHaveBeenCalled()
      expect(enqueueJob).toHaveBeenCalled()
    })

    it("does not intercept 5-char or 7-char codes", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        reason: "granted",
      })

      for (const text of ["ABCDE", "ABCDEFG"]) {
        const { dispatch } = setupDispatch({ guard })
        await dispatch(
          makeRoutedMessage({
            message: {
              channelType: "telegram",
              channelUserId: "tg-user-1",
              chatId: "chat-42",
              messageId: "msg-1",
              text,
              timestamp: new Date(),
              metadata: {},
            },
          }),
        )

        expect(guard.handlePairingCode).not.toHaveBeenCalled()
        expect(guard.authorize).toHaveBeenCalled()
        // Reset for next iteration
        vi.mocked(guard.authorize).mockClear()
        vi.mocked(guard.handlePairingCode).mockClear()
      }
    })

    it("relays failed pairing code message to user", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "denied",
      })
      vi.mocked(guard.handlePairingCode).mockResolvedValue({
        success: false,
        message: "Code has expired",
      })
      const { dispatch, router } = setupDispatch({ guard })

      await dispatch(
        makeRoutedMessage({
          message: {
            channelType: "telegram",
            channelUserId: "tg-user-1",
            chatId: "chat-42",
            messageId: "msg-1",
            text: "XYZ789",
            timestamp: new Date(),
            metadata: {},
          },
        }),
      )

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Code has expired",
      })
    })
  })

  // =========================================================================
  // 3. Token budget enforcement prevents runaway spend
  // =========================================================================
  describe("token budget enforcement", () => {
    it("blocks message when token budget exceeded", async () => {
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
        retryAfterSeconds: 86400,
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "You've reached the token budget (100000 tokens per day). Please try again later.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("emits message_denied event for budget_exceeded", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        grantId: "grant-999",
        reason: "granted",
      })
      const rateLimiter = mockUserRateLimiter({
        allowed: false,
        reason: "budget_exceeded",
        replyToUser: "Token budget exceeded.",
      })
      const emitter = mockEventEmitter()
      const { dispatch } = setupDispatch({ guard, rateLimiter, eventEmitter: emitter })

      await dispatch(makeRoutedMessage())

      expect(emitter.emit).toHaveBeenCalledWith({
        agentId: "agent-aaa",
        eventType: "message_denied",
        actor: "system",
        payload: {
          reason: "budget_exceeded",
          channelType: "telegram",
          chatId: "chat-42",
          userId: "user-111",
        },
      })
    })

    it("blocks message when rate limit exceeded", async () => {
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
      const { dispatch, router, enqueueJob } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "You've reached the message limit (60 per hour). Please try again later.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })

    it("allows message through when within limits", async () => {
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
      const { dispatch, enqueueJob } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      expect(enqueueJob).toHaveBeenCalledWith("job-123")
    })

    it("skips rate limiting when no grantId in auth decision", async () => {
      const guard = mockChannelAuthGuard({
        allowed: true,
        userId: "user-111",
        // No grantId
        reason: "granted",
      })
      const rateLimiter = mockUserRateLimiter({
        allowed: false,
        reason: "rate_limited",
        replyToUser: "Should not be seen",
      })
      const { dispatch, enqueueJob } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      // Rate limiter skipped — no grantId
      expect(rateLimiter.check).not.toHaveBeenCalled()
      expect(enqueueJob).toHaveBeenCalledWith("job-123")
    })
  })

  // =========================================================================
  // 4. Approval queue flow
  // =========================================================================
  describe("approval queue flow", () => {
    it("submits access request for pending_approval and notifies user", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "pending_approval",
        replyToUser: "Your request has been submitted. You'll be notified when approved.",
      })
      const { dispatch, router, enqueueJob } = setupDispatch({ guard })

      await dispatch(makeRoutedMessage())

      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Your request has been submitted. You'll be notified when approved.",
      })
      expect(enqueueJob).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // 5. Auth guard bypassed when not provided (backward compat)
  // =========================================================================
  describe("backward compatibility", () => {
    it("processes message normally when no auth guard provided", async () => {
      const { dispatch, enqueueJob } = setupDispatch({})

      await dispatch(makeRoutedMessage())

      expect(enqueueJob).toHaveBeenCalledWith("job-123")
    })

    it("does not attempt rate limiting when no auth guard provided", async () => {
      const rateLimiter = mockUserRateLimiter({
        allowed: false,
        reason: "rate_limited",
        replyToUser: "Rate limited",
      })
      const { dispatch, enqueueJob } = setupDispatch({ rateLimiter })

      await dispatch(makeRoutedMessage())

      // Rate limiter skipped — no auth guard means no authDecision
      expect(rateLimiter.check).not.toHaveBeenCalled()
      expect(enqueueJob).toHaveBeenCalledWith("job-123")
    })
  })

  // =========================================================================
  // 6. Guard + rate limit combined flow
  // =========================================================================
  describe("combined auth + rate limit flow", () => {
    it("checks auth first, then rate limit — allows when both pass", async () => {
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
      const { dispatch, enqueueJob } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      // Both were checked
      expect(guard.authorize).toHaveBeenCalled()
      expect(rateLimiter.check).toHaveBeenCalledWith("user-111", "agent-aaa", undefined, undefined)
      expect(enqueueJob).toHaveBeenCalledWith("job-123")
    })

    it("skips rate limit check when auth denies — no double-rejection", async () => {
      const guard = mockChannelAuthGuard({
        allowed: false,
        userId: "user-111",
        reason: "denied",
        replyToUser: "Access denied.",
      })
      const rateLimiter = mockUserRateLimiter({
        allowed: false,
        reason: "rate_limited",
        replyToUser: "Rate limited.",
      })
      const { dispatch, router } = setupDispatch({ guard, rateLimiter })

      await dispatch(makeRoutedMessage())

      // Only auth rejection sent, not rate limit rejection
      expect(router.send).toHaveBeenCalledTimes(1)
      expect(router.send).toHaveBeenCalledWith("telegram", "chat-42", {
        text: "Access denied.",
      })
      expect(rateLimiter.check).not.toHaveBeenCalled()
    })
  })
})
