import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../../db/types.js"
import { type CostBudget, CostTracker, type RecordLlmCostParams } from "../cost-tracker.js"
import type { AgentEventEmitter } from "../event-emitter.js"
import { DEFAULT_PRICING, estimateCost, MODEL_PRICING } from "../model-pricing.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildMockDb(
  opts: {
    jobCostUsd?: string
    sessionCostUsd?: string
    dailyCost?: string
    sessionRow?: {
      total_tokens_in: number
      total_tokens_out: number
      total_cost_usd: string
    } | null
    summaryRow?: Record<string, unknown>
    modelRows?: Array<Record<string, unknown>>
    countRow?: Record<string, unknown>
  } = {},
) {
  const {
    jobCostUsd = "0.010500",
    sessionCostUsd = "0.050000",
    dailyCost: _dailyCost = "0.100000",
    sessionRow = null,
    summaryRow = {
      total_cost: "0.500000",
      total_tokens_in: 10000,
      total_tokens_out: 5000,
      llm_calls: 5,
      tool_calls: 3,
    },
    modelRows = [],
    countRow = { llm_calls: 5, tool_calls: 3 },
  } = opts

  const updateExecuteTakeFirst = vi.fn()
  const updateReturning = vi.fn()
  const updateWhere = vi.fn()
  const updateSet = vi.fn()

  // Track which table is being updated to return correct values
  let currentUpdateTable = ""

  updateExecuteTakeFirst.mockImplementation(() => {
    if (currentUpdateTable === "job") {
      return Promise.resolve({ cost_usd: jobCostUsd })
    }
    if (currentUpdateTable === "session") {
      return Promise.resolve({ total_cost_usd: sessionCostUsd })
    }
    return Promise.resolve(null)
  })

  updateReturning.mockReturnValue({
    executeTakeFirst: updateExecuteTakeFirst,
  })

  updateWhere.mockReturnValue({
    returning: updateReturning,
    where: updateWhere,
    executeTakeFirst: updateExecuteTakeFirst,
  })

  updateSet.mockReturnValue({
    where: updateWhere,
    returning: updateReturning,
  })

  const selectExecute = vi.fn().mockResolvedValue(modelRows)
  const selectExecuteTakeFirst = vi.fn().mockImplementation(() => {
    return Promise.resolve(sessionRow)
  })
  const selectExecuteTakeFirstOrThrow = vi.fn().mockImplementation(() => {
    return Promise.resolve(summaryRow)
  })

  // Track select-from context for different queries
  let selectCallIndex = 0

  function makeSelectChain() {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    const where = vi.fn().mockReturnValue(chain)
    const select = vi.fn().mockReturnValue(chain)
    const selectAll = vi.fn().mockReturnValue(chain)
    const groupBy = vi.fn().mockReturnValue(chain)
    const orderBy = vi.fn().mockReturnValue(chain)
    const limit = vi.fn().mockReturnValue(chain)

    Object.assign(chain, {
      where,
      select,
      selectAll,
      groupBy,
      orderBy,
      limit,
      execute: selectExecute,
      executeTakeFirst: selectExecuteTakeFirst,
      executeTakeFirstOrThrow: selectExecuteTakeFirstOrThrow,
    })
    return chain
  }

  const selectFrom = vi.fn().mockImplementation((table: string) => {
    selectCallIndex++
    if (table === "session") {
      // Return session row
      const chain = makeSelectChain()
      chain.executeTakeFirst = vi.fn().mockResolvedValue(sessionRow)
      return chain
    }
    if (table === "agent_event") {
      const chain = makeSelectChain()
      // First agent_event query returns summary, subsequent return modelRows or countRow
      if (selectCallIndex <= 1) {
        chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(summaryRow)
      } else {
        chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(countRow)
      }
      chain.execute = vi.fn().mockResolvedValue(modelRows)
      return chain
    }
    return makeSelectChain()
  })

  const updateTable = vi.fn().mockImplementation((table: string) => {
    currentUpdateTable = table
    return { set: updateSet }
  })

  const db = {
    updateTable,
    selectFrom,
    fn: { countAll: vi.fn() },
  } as unknown as Kysely<Database>

  return {
    db,
    updateTable,
    updateSet,
    updateWhere,
    updateReturning,
    updateExecuteTakeFirst,
    selectFrom,
    selectExecute,
    selectExecuteTakeFirst,
    selectExecuteTakeFirstOrThrow,
  }
}

function buildMockEmitter() {
  const emit = vi.fn().mockResolvedValue({ eventId: "evt-1" })
  const emitter = { emit } as unknown as AgentEventEmitter
  return { emitter, emit }
}

const DEFAULT_BUDGET: CostBudget = {
  maxUsdPerJob: 1.0,
  maxUsdPerSession: 5.0,
  maxUsdPerDay: 10.0,
  warningThresholdPct: 0.8,
}

function baseRecordParams(overrides?: Partial<RecordLlmCostParams>): RecordLlmCostParams {
  return {
    agentId: "agent-1",
    jobId: "job-1",
    sessionId: "sess-1",
    model: "claude-sonnet-4-6",
    tokensIn: 1000,
    tokensOut: 500,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("model-pricing", () => {
  describe("estimateCost()", () => {
    it("returns correct cost for claude-sonnet-4-6", () => {
      // 1000 in * 3.0/1M + 500 out * 15.0/1M = 0.003 + 0.0075 = 0.0105
      const cost = estimateCost("claude-sonnet-4-6", 1000, 500)
      expect(cost).toBeCloseTo(0.0105, 6)
    })

    it("returns correct cost for claude-opus-4-6", () => {
      // 1000 * 15/1M + 500 * 75/1M = 0.015 + 0.0375 = 0.0525
      const cost = estimateCost("claude-opus-4-6", 1000, 500)
      expect(cost).toBeCloseTo(0.0525, 6)
    })

    it("returns correct cost for gpt-4o", () => {
      // 1000 * 2.5/1M + 500 * 10.0/1M = 0.0025 + 0.005 = 0.0075
      const cost = estimateCost("gpt-4o", 1000, 500)
      expect(cost).toBeCloseTo(0.0075, 6)
    })

    it("uses default pricing for unknown model (not zero)", () => {
      const cost = estimateCost("unknown-model-xyz", 1000, 500)
      const expected =
        (1000 / 1_000_000) * DEFAULT_PRICING.inputPerMToken +
        (500 / 1_000_000) * DEFAULT_PRICING.outputPerMToken
      expect(cost).toBeCloseTo(expected, 6)
      expect(cost).toBeGreaterThan(0)
    })

    it("includes cache read tokens when pricing supports it", () => {
      const withoutCache = estimateCost("claude-sonnet-4-6", 1000, 500)
      const withCache = estimateCost("claude-sonnet-4-6", 1000, 500, 2000)
      // Cache cost: 2000 * 0.3/1M = 0.0006
      expect(withCache - withoutCache).toBeCloseTo(0.0006, 6)
    })

    it("ignores cache read tokens when model has no cache pricing", () => {
      const withoutCache = estimateCost("gpt-4o", 1000, 500)
      const withCache = estimateCost("gpt-4o", 1000, 500, 2000)
      expect(withCache).toBe(withoutCache)
    })

    it("returns 0 for zero token counts", () => {
      expect(estimateCost("claude-sonnet-4-6", 0, 0)).toBe(0)
    })
  })

  describe("MODEL_PRICING", () => {
    it("contains entries for common models", () => {
      expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined()
      expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined()
      expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined()
      expect(MODEL_PRICING["gpt-4o"]).toBeDefined()
      expect(MODEL_PRICING["gpt-4o-mini"]).toBeDefined()
    })

    it("all prices are positive", () => {
      for (const [, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.inputPerMToken).toBeGreaterThan(0)
        expect(pricing.outputPerMToken).toBeGreaterThan(0)
      }
    })
  })
})

describe("CostTracker", () => {
  describe("estimateCost()", () => {
    it("delegates to model pricing table", () => {
      const { db } = buildMockDb()
      const tracker = new CostTracker(db)
      const cost = tracker.estimateCost("claude-sonnet-4-6", 1000, 500)
      expect(cost).toBeCloseTo(0.0105, 6)
    })
  })

  // ── recordLlmCost() ──────────────────────────────────────────────────

  describe("recordLlmCost()", () => {
    it("atomically increments job.tokens_in, tokens_out, cost_usd, llm_call_count", async () => {
      const { db, updateTable, updateSet } = buildMockDb()
      const tracker = new CostTracker(db)

      await tracker.recordLlmCost(baseRecordParams())

      // First updateTable call should be for "job"
      expect(updateTable).toHaveBeenCalledWith("job")
      expect(updateSet).toHaveBeenCalled()
    })

    it("atomically increments session.total_tokens_in, total_tokens_out, total_cost_usd", async () => {
      const { db, updateTable } = buildMockDb()
      const tracker = new CostTracker(db)

      await tracker.recordLlmCost(baseRecordParams({ sessionId: "sess-1" }))

      // Should call updateTable for both "job" and "session"
      expect(updateTable).toHaveBeenCalledWith("job")
      expect(updateTable).toHaveBeenCalledWith("session")
    })

    it("skips session update when sessionId is null", async () => {
      const { db, updateTable } = buildMockDb()
      const tracker = new CostTracker(db)

      await tracker.recordLlmCost(baseRecordParams({ sessionId: null }))

      // Only job should be updated
      expect(updateTable).toHaveBeenCalledTimes(1)
      expect(updateTable).toHaveBeenCalledWith("job")
    })

    it("returns estimated cost in USD", async () => {
      const { db } = buildMockDb()
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(baseRecordParams())

      expect(result.costUsd).toBeCloseTo(0.0105, 6)
    })

    it("returns empty budgetStatuses when no budget provided", async () => {
      const { db } = buildMockDb()
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(baseRecordParams({ budget: undefined }))

      expect(result.budgetStatuses).toEqual([])
    })

    // ── Budget enforcement ────────────────────────────────────────────

    it("returns job exceeded when job cost exceeds maxUsdPerJob", async () => {
      const { db } = buildMockDb({ jobCostUsd: "1.500000" })
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(
        baseRecordParams({ budget: { ...DEFAULT_BUDGET, maxUsdPerJob: 1.0 } }),
      )

      const jobStatus = result.budgetStatuses.find((s) => s.level === "job")
      expect(jobStatus).toBeDefined()
      expect(jobStatus!.exceeded).toBe(true)
      expect(jobStatus!.currentUsd).toBe(1.5)
      expect(jobStatus!.limitUsd).toBe(1.0)
    })

    it("returns session exceeded when session cost exceeds maxUsdPerSession", async () => {
      const { db } = buildMockDb({ sessionCostUsd: "6.000000" })
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(
        baseRecordParams({ budget: { ...DEFAULT_BUDGET, maxUsdPerSession: 5.0 } }),
      )

      const sessionStatus = result.budgetStatuses.find((s) => s.level === "session")
      expect(sessionStatus).toBeDefined()
      expect(sessionStatus!.exceeded).toBe(true)
    })

    it("returns daily exceeded when daily cost exceeds maxUsdPerDay", async () => {
      // getDailyCost reads from agent_event
      const summaryRow = { daily_cost: "15.000000" }
      const { db } = buildMockDb()
      // Override selectFrom for the daily cost query
      const selectChain: Record<string, ReturnType<typeof vi.fn>> = {}
      const where = vi.fn().mockReturnValue(selectChain)
      const select = vi.fn().mockReturnValue(selectChain)
      Object.assign(selectChain, {
        where,
        select,
        executeTakeFirstOrThrow: vi.fn().mockResolvedValue(summaryRow),
        execute: vi.fn().mockResolvedValue([]),
        executeTakeFirst: vi.fn().mockResolvedValue(null),
      })
      ;(db.selectFrom as ReturnType<typeof vi.fn>).mockReturnValue(selectChain)

      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(
        baseRecordParams({ budget: { ...DEFAULT_BUDGET, maxUsdPerDay: 10.0 } }),
      )

      const dailyStatus = result.budgetStatuses.find((s) => s.level === "daily")
      expect(dailyStatus).toBeDefined()
      expect(dailyStatus!.exceeded).toBe(true)
      expect(dailyStatus!.currentUsd).toBe(15)
      expect(dailyStatus!.limitUsd).toBe(10)
    })

    it("returns warning at 80% threshold", async () => {
      // Job cost at 85% of budget (0.85 of 1.0)
      const { db } = buildMockDb({ jobCostUsd: "0.850000" })
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(
        baseRecordParams({
          budget: { ...DEFAULT_BUDGET, maxUsdPerJob: 1.0, warningThresholdPct: 0.8 },
        }),
      )

      const jobStatus = result.budgetStatuses.find((s) => s.level === "job")
      expect(jobStatus).toBeDefined()
      expect(jobStatus!.warning).toBe(true)
      expect(jobStatus!.exceeded).toBe(false)
    })

    it("emits cost_alert event via eventEmitter on budget warning", async () => {
      const { db } = buildMockDb({ jobCostUsd: "0.850000" })
      const { emitter, emit } = buildMockEmitter()
      const tracker = new CostTracker(db, emitter)

      await tracker.recordLlmCost(
        baseRecordParams({
          budget: { ...DEFAULT_BUDGET, maxUsdPerJob: 1.0, warningThresholdPct: 0.8 },
        }),
      )

      expect(emit).toHaveBeenCalled()
      const call = emit.mock.calls[0]![0] as Record<string, unknown>
      expect(call.eventType).toBe("cost_alert")
      expect(call.actor).toBe("system")
      expect(call.agentId).toBe("agent-1")
      const payload = call.payload as Record<string, unknown>
      expect(payload.warning).toBe(true)
      expect(payload.level).toBe("job")
    })

    it("emits cost_alert event on budget exceeded", async () => {
      const { db } = buildMockDb({ jobCostUsd: "1.500000" })
      const { emitter, emit } = buildMockEmitter()
      const tracker = new CostTracker(db, emitter)

      await tracker.recordLlmCost(
        baseRecordParams({
          budget: { ...DEFAULT_BUDGET, maxUsdPerJob: 1.0 },
        }),
      )

      expect(emit).toHaveBeenCalled()
      const call = emit.mock.calls[0]![0] as Record<string, unknown>
      expect(call.eventType).toBe("cost_alert")
      const payload = call.payload as Record<string, unknown>
      expect(payload.exceeded).toBe(true)
    })

    it("does not emit events when no eventEmitter provided", async () => {
      const { db } = buildMockDb({ jobCostUsd: "1.500000" })
      const tracker = new CostTracker(db) // no emitter

      // Should not throw
      const result = await tracker.recordLlmCost(baseRecordParams({ budget: DEFAULT_BUDGET }))

      expect(result.budgetStatuses.some((s) => s.exceeded)).toBe(true)
    })

    it("skips budget levels with zero limits", async () => {
      const { db } = buildMockDb()
      const tracker = new CostTracker(db)

      const result = await tracker.recordLlmCost(
        baseRecordParams({
          budget: {
            maxUsdPerJob: 0,
            maxUsdPerSession: 0,
            maxUsdPerDay: 0,
            warningThresholdPct: 0.8,
          },
        }),
      )

      expect(result.budgetStatuses).toHaveLength(0)
    })
  })

  // ── getAgentCostSummary() ─────────────────────────────────────────

  describe("getAgentCostSummary()", () => {
    it("aggregates cost correctly from agent_event", async () => {
      const { db } = buildMockDb({
        summaryRow: {
          total_cost: "1.250000",
          total_tokens_in: 25000,
          total_tokens_out: 12000,
          llm_calls: 10,
          tool_calls: 7,
        },
        modelRows: [
          { model: "claude-sonnet-4-6", cost: "0.800000", tokens_in: 15000, tokens_out: 8000 },
          { model: "gpt-4o", cost: "0.450000", tokens_in: 10000, tokens_out: 4000 },
        ],
      })
      const tracker = new CostTracker(db)

      const summary = await tracker.getAgentCostSummary("agent-1")

      expect(summary.totalCostUsd).toBe(1.25)
      expect(summary.totalTokensIn).toBe(25000)
      expect(summary.totalTokensOut).toBe(12000)
      expect(summary.totalLlmCalls).toBe(10)
      expect(summary.totalToolCalls).toBe(7)
      expect(summary.byModel["claude-sonnet-4-6"]).toEqual({
        costUsd: 0.8,
        tokensIn: 15000,
        tokensOut: 8000,
      })
      expect(summary.byModel["gpt-4o"]).toEqual({
        costUsd: 0.45,
        tokensIn: 10000,
        tokensOut: 4000,
      })
    })

    it("applies since date filter", async () => {
      const { db, selectFrom } = buildMockDb()
      const tracker = new CostTracker(db)

      const since = new Date("2025-01-01")
      await tracker.getAgentCostSummary("agent-1", since)

      // Verify selectFrom was called with agent_event
      expect(selectFrom).toHaveBeenCalledWith("agent_event")
    })

    it("returns zeros when no events exist", async () => {
      const { db } = buildMockDb({
        summaryRow: {
          total_cost: "0",
          total_tokens_in: 0,
          total_tokens_out: 0,
          llm_calls: 0,
          tool_calls: 0,
        },
        modelRows: [],
      })
      const tracker = new CostTracker(db)

      const summary = await tracker.getAgentCostSummary("agent-1")

      expect(summary.totalCostUsd).toBe(0)
      expect(summary.totalTokensIn).toBe(0)
      expect(summary.totalTokensOut).toBe(0)
      expect(summary.totalLlmCalls).toBe(0)
      expect(summary.totalToolCalls).toBe(0)
      expect(summary.byModel).toEqual({})
    })

    it("labels null model as 'unknown' in byModel", async () => {
      const { db } = buildMockDb({
        modelRows: [{ model: null, cost: "0.100000", tokens_in: 1000, tokens_out: 500 }],
      })
      const tracker = new CostTracker(db)

      const summary = await tracker.getAgentCostSummary("agent-1")

      expect(summary.byModel["unknown"]).toBeDefined()
      expect(summary.byModel["unknown"]!.costUsd).toBe(0.1)
    })
  })

  // ── getSessionCostSummary() ───────────────────────────────────────

  describe("getSessionCostSummary()", () => {
    it("reads cost from session columns", async () => {
      const { db } = buildMockDb({
        sessionRow: {
          total_tokens_in: 8000,
          total_tokens_out: 4000,
          total_cost_usd: "0.750000",
        },
        countRow: { llm_calls: 4, tool_calls: 2 },
        modelRows: [
          { model: "claude-sonnet-4-6", cost: "0.750000", tokens_in: 8000, tokens_out: 4000 },
        ],
      })
      const tracker = new CostTracker(db)

      const summary = await tracker.getSessionCostSummary("sess-1")

      expect(summary.totalCostUsd).toBe(0.75)
      expect(summary.totalTokensIn).toBe(8000)
      expect(summary.totalTokensOut).toBe(4000)
      expect(summary.totalLlmCalls).toBe(4)
      expect(summary.totalToolCalls).toBe(2)
    })

    it("returns zeros when session not found", async () => {
      const { db } = buildMockDb({ sessionRow: null })
      const tracker = new CostTracker(db)

      const summary = await tracker.getSessionCostSummary("nonexistent")

      expect(summary.totalCostUsd).toBe(0)
      expect(summary.totalTokensIn).toBe(0)
      expect(summary.totalTokensOut).toBe(0)
      expect(summary.totalLlmCalls).toBe(0)
      expect(summary.totalToolCalls).toBe(0)
      expect(summary.byModel).toEqual({})
    })
  })
})
