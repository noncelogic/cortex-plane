/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database, RateLimit, TokenBudget } from "../../db/types.js"
import { UserRateLimiter } from "../user-rate-limiter.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"

// ---------------------------------------------------------------------------
// Chainable Kysely mock helpers
// ---------------------------------------------------------------------------

function mockSelectChain(result: unknown) {
  const executeTakeFirst = vi.fn().mockResolvedValue(result)
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
  const execute = vi
    .fn()
    .mockResolvedValue(Array.isArray(result) ? result : result == null ? [] : [result])
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const selectFn = vi.fn()
  const innerJoinFn: ReturnType<typeof vi.fn> = vi.fn()
  const chain = {
    where: whereFn,
    select: selectFn,
    innerJoin: innerJoinFn,
    executeTakeFirst,
    executeTakeFirstOrThrow,
    execute,
  }
  whereFn.mockReturnValue(chain)
  selectFn.mockReturnValue(chain)
  innerJoinFn.mockReturnValue(chain)
  return chain
}

function mockInsertChain() {
  const executeFn = vi.fn().mockResolvedValue(undefined)
  const onConflictFn = vi.fn()
  const doUpdateSetFn = vi.fn()
  const columnsFn = vi.fn()
  const valuesFn = vi.fn()

  const conflictChain = {
    columns: columnsFn,
    doUpdateSet: doUpdateSetFn,
  }
  columnsFn.mockReturnValue(conflictChain)
  doUpdateSetFn.mockReturnValue({ execute: executeFn })

  // onConflict receives a builder callback — invoke it with our chain
  onConflictFn.mockImplementation((cb: (oc: typeof conflictChain) => unknown) => {
    cb(conflictChain)
    return { execute: executeFn }
  })

  const chain = {
    values: valuesFn,
    onConflict: onConflictFn,
    execute: executeFn,
  }
  valuesFn.mockReturnValue(chain)

  return chain
}

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

interface MockDbOpts {
  agentResourceLimits?: Record<string, unknown>
  messageCount?: number
  totalTokens?: number
}

function buildMockDb(opts: MockDbOpts = {}) {
  const { agentResourceLimits = {}, messageCount = 0, totalTokens = 0 } = opts

  const selectFromCalls: string[] = []

  const insertChain = mockInsertChain()

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      selectFromCalls.push(table)

      if (table === "agent") {
        return mockSelectChain({ resource_limits: agentResourceLimits })
      }

      // session_message as sm — rate limit query
      if (table === "session_message as sm") {
        return mockSelectChain({ count: messageCount })
      }

      // user_usage_ledger — token budget query / usage summary
      if (table === "user_usage_ledger") {
        return mockSelectChain({
          total_tokens: totalTokens,
          messages_sent: messageCount,
          tokens_in: Math.floor(totalTokens * 0.6),
          tokens_out: Math.floor(totalTokens * 0.4),
          cost_usd: 0.5,
        })
      }

      return mockSelectChain(null)
    }),
    insertInto: vi.fn().mockReturnValue(insertChain),
  } as unknown as Kysely<Database>

  return { db, selectFromCalls, insertChain }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserRateLimiter", () => {
  // ── check() ──

  describe("check()", () => {
    it("allows user within rate limit", async () => {
      const { db } = buildMockDb({ messageCount: 5 })
      const limiter = new UserRateLimiter(db)

      const grantRateLimit: RateLimit = { max_messages: 60, window_seconds: 3600 }
      const result = await limiter.check(USER_ID, AGENT_ID, grantRateLimit)

      expect(result).toEqual({ allowed: true, reason: "allowed" })
    })

    it("denies user exceeding message rate limit", async () => {
      const { db } = buildMockDb({ messageCount: 60 })
      const limiter = new UserRateLimiter(db)

      const grantRateLimit: RateLimit = { max_messages: 60, window_seconds: 3600 }
      const result = await limiter.check(USER_ID, AGENT_ID, grantRateLimit)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("rate_limited")
      expect(result.replyToUser).toContain("message limit")
      expect(result.retryAfterSeconds).toBe(3600)
    })

    it("denies user exceeding token budget", async () => {
      const { db } = buildMockDb({ messageCount: 5, totalTokens: 100_000 })
      const limiter = new UserRateLimiter(db)

      const grantTokenBudget: TokenBudget = { max_tokens: 100_000, window_seconds: 86400 }
      const result = await limiter.check(USER_ID, AGENT_ID, null, grantTokenBudget)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("budget_exceeded")
      expect(result.replyToUser).toContain("token budget")
      expect(result.retryAfterSeconds).toBe(86400)
    })

    it("per-grant override takes precedence over agent default", async () => {
      // Agent default: 100 messages/hr — would allow
      // Grant override: 10 messages/hr — should deny at count=15
      const { db } = buildMockDb({
        agentResourceLimits: {
          userRateLimit: { max_messages: 100, window_seconds: 3600 },
        },
        messageCount: 15,
      })
      const limiter = new UserRateLimiter(db)

      const grantRateLimit: RateLimit = { max_messages: 10, window_seconds: 3600 }
      const result = await limiter.check(USER_ID, AGENT_ID, grantRateLimit)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("rate_limited")
    })

    it("falls back to agent default when grant has no rate limit", async () => {
      const { db } = buildMockDb({
        agentResourceLimits: {
          userRateLimit: { max_messages: 10, window_seconds: 3600 },
        },
        messageCount: 15,
      })
      const limiter = new UserRateLimiter(db)

      // No grant-level override
      const result = await limiter.check(USER_ID, AGENT_ID)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("rate_limited")
    })

    it("allows when no limits configured at any level", async () => {
      const { db } = buildMockDb({
        agentResourceLimits: {},
        messageCount: 1000,
        totalTokens: 1_000_000,
      })
      const limiter = new UserRateLimiter(db)

      const result = await limiter.check(USER_ID, AGENT_ID)

      expect(result).toEqual({ allowed: true, reason: "allowed" })
    })

    it("checks rate limit before token budget", async () => {
      // Both limits exceeded — should return rate_limited (checked first)
      const { db } = buildMockDb({ messageCount: 60, totalTokens: 100_000 })
      const limiter = new UserRateLimiter(db)

      const grantRateLimit: RateLimit = { max_messages: 60, window_seconds: 3600 }
      const grantTokenBudget: TokenBudget = { max_tokens: 100_000, window_seconds: 86400 }
      const result = await limiter.check(USER_ID, AGENT_ID, grantRateLimit, grantTokenBudget)

      expect(result.reason).toBe("rate_limited")
    })

    it("agent default takes precedence over platform default (no limit)", async () => {
      const { db } = buildMockDb({
        agentResourceLimits: {
          userTokenBudget: { max_tokens: 50_000, window_seconds: 86400 },
        },
        totalTokens: 60_000,
      })
      const limiter = new UserRateLimiter(db)

      const result = await limiter.check(USER_ID, AGENT_ID)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe("budget_exceeded")
    })
  })

  // ── recordUsage() ──

  describe("recordUsage()", () => {
    it("upserts into correct hourly bucket", async () => {
      const { db, insertChain } = buildMockDb()
      const limiter = new UserRateLimiter(db)

      await limiter.recordUsage(USER_ID, AGENT_ID, 1, 500, 200, 0.01)

      expect(db.insertInto).toHaveBeenCalledWith("user_usage_ledger")
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          user_account_id: USER_ID,
          agent_id: AGENT_ID,
          messages_sent: 1,
          tokens_in: 500,
          tokens_out: 200,
          cost_usd: 0.01,
        }) as Record<string, unknown>,
      )
      expect(insertChain.onConflict).toHaveBeenCalled()
    })

    it("sets period_start to floor of current hour", async () => {
      const { db, insertChain } = buildMockDb()
      const limiter = new UserRateLimiter(db)

      await limiter.recordUsage(USER_ID, AGENT_ID, 1, 100, 50, 0.005)

      const callArgs = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>
      const periodStart = callArgs.period_start as Date
      const periodEnd = callArgs.period_end as Date

      expect(periodStart.getUTCMinutes()).toBe(0)
      expect(periodStart.getUTCSeconds()).toBe(0)
      expect(periodStart.getUTCMilliseconds()).toBe(0)

      // period_end should be exactly 1 hour after period_start
      expect(periodEnd.getTime() - periodStart.getTime()).toBe(3_600_000)
    })
  })

  // ── getUsageSummary() ──

  describe("getUsageSummary()", () => {
    it("returns correct aggregates for requested window", async () => {
      const { db } = buildMockDb({ messageCount: 10, totalTokens: 5000 })
      const limiter = new UserRateLimiter(db)

      const summary = await limiter.getUsageSummary(USER_ID, AGENT_ID, 3600)

      expect(summary.windowSeconds).toBe(3600)
      expect(summary.messagesSent).toBe(10)
      expect(typeof summary.tokensIn).toBe("number")
      expect(typeof summary.tokensOut).toBe("number")
      expect(typeof summary.costUsd).toBe("number")
    })

    it("queries user_usage_ledger table", async () => {
      const { db } = buildMockDb()
      const limiter = new UserRateLimiter(db)

      await limiter.getUsageSummary(USER_ID, AGENT_ID, 86400)

      expect(db.selectFrom).toHaveBeenCalledWith("user_usage_ledger")
    })
  })
})
