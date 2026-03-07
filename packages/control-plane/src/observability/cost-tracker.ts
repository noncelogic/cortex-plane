/**
 * CostTracker — cost estimation, accumulation, and budget enforcement.
 *
 * Wraps atomic SQL increments on `job` and `session` tables, checks cost
 * budgets at job / session / daily levels, and emits `cost_alert` events
 * when thresholds are breached.
 */

import { type Kysely, sql } from "kysely"

import type { Database } from "../db/types.js"
import type { AgentEventEmitter } from "./event-emitter.js"
import { estimateCost } from "./model-pricing.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBudget {
  maxUsdPerJob: number
  maxUsdPerSession: number
  maxUsdPerDay: number
  /** Fraction 0–1 (e.g. 0.8 = 80%). */
  warningThresholdPct: number
}

export interface BudgetStatus {
  exceeded: boolean
  warning: boolean
  currentUsd: number
  limitUsd: number
  level: "job" | "session" | "daily"
}

export interface CostSummary {
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  totalLlmCalls: number
  totalToolCalls: number
  byModel: Record<string, { costUsd: number; tokensIn: number; tokensOut: number }>
}

export interface RecordLlmCostParams {
  agentId: string
  jobId: string
  sessionId?: string | null
  model: string
  tokensIn: number
  tokensOut: number
  cacheReadTokens?: number
  budget?: CostBudget
}

export interface RecordLlmCostResult {
  costUsd: number
  budgetStatuses: BudgetStatus[]
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CostTracker {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly eventEmitter?: AgentEventEmitter,
  ) {}

  /**
   * Estimate the cost of an LLM call in USD.
   * Delegates to the model pricing table.
   */
  estimateCost(
    model: string,
    tokensIn: number,
    tokensOut: number,
    cacheReadTokens?: number,
  ): number {
    return estimateCost(model, tokensIn, tokensOut, cacheReadTokens)
  }

  /**
   * Record an LLM call's token usage and cost.
   *
   * 1. Atomically increments `job.tokens_in`, `tokens_out`, `cost_usd`,
   *    `llm_call_count`.
   * 2. Atomically increments `session.total_tokens_in`, `total_tokens_out`,
   *    `total_cost_usd` (when `sessionId` is provided).
   * 3. Checks cost budgets and emits `cost_alert` events on breach.
   */
  async recordLlmCost(params: RecordLlmCostParams): Promise<RecordLlmCostResult> {
    const costUsd = estimateCost(
      params.model,
      params.tokensIn,
      params.tokensOut,
      params.cacheReadTokens,
    )

    // ── Atomic increment on job ──────────────────────────────────────────
    const jobRow = await this.db
      .updateTable("job")
      .set({
        tokens_in: sql`"tokens_in" + ${params.tokensIn}`,
        tokens_out: sql`"tokens_out" + ${params.tokensOut}`,
        cost_usd: sql`"cost_usd" + ${costUsd}`,
        llm_call_count: sql`"llm_call_count" + 1`,
      })
      .where("id", "=", params.jobId)
      .returning(["cost_usd"])
      .executeTakeFirst()

    // ── Atomic increment on session ──────────────────────────────────────
    let sessionCostUsd: number | null = null
    if (params.sessionId) {
      const sessionRow = await this.db
        .updateTable("session")
        .set({
          total_tokens_in: sql`"total_tokens_in" + ${params.tokensIn}`,
          total_tokens_out: sql`"total_tokens_out" + ${params.tokensOut}`,
          total_cost_usd: sql`"total_cost_usd" + ${costUsd}`,
        })
        .where("id", "=", params.sessionId)
        .returning(["total_cost_usd"])
        .executeTakeFirst()

      if (sessionRow) {
        sessionCostUsd = Number(sessionRow.total_cost_usd)
      }
    }

    // ── Budget enforcement ───────────────────────────────────────────────
    const budgetStatuses: BudgetStatus[] = []

    if (params.budget) {
      const { budget, agentId, jobId, sessionId } = params
      const warnPct = budget.warningThresholdPct

      // Job-level
      if (budget.maxUsdPerJob > 0 && jobRow) {
        const current = Number(jobRow.cost_usd)
        const status = checkThreshold(current, budget.maxUsdPerJob, warnPct, "job")
        budgetStatuses.push(status)
        if (status.warning || status.exceeded) {
          await this.emitCostAlert(agentId, jobId, sessionId ?? null, status)
        }
      }

      // Session-level
      if (budget.maxUsdPerSession > 0 && sessionCostUsd != null) {
        const status = checkThreshold(sessionCostUsd, budget.maxUsdPerSession, warnPct, "session")
        budgetStatuses.push(status)
        if (status.warning || status.exceeded) {
          await this.emitCostAlert(agentId, jobId, sessionId ?? null, status)
        }
      }

      // Daily-level
      if (budget.maxUsdPerDay > 0) {
        const dailyCost = await this.getDailyCost(agentId)
        const status = checkThreshold(dailyCost, budget.maxUsdPerDay, warnPct, "daily")
        budgetStatuses.push(status)
        if (status.warning || status.exceeded) {
          await this.emitCostAlert(agentId, jobId, sessionId ?? null, status)
        }
      }
    }

    return { costUsd, budgetStatuses }
  }

  /**
   * Aggregate cost summary for an agent from the `agent_event` table.
   */
  async getAgentCostSummary(agentId: string, since?: Date): Promise<CostSummary> {
    let baseQuery = this.db.selectFrom("agent_event").where("agent_id", "=", agentId)

    if (since) {
      baseQuery = baseQuery.where("created_at", ">=", since)
    }

    const summary = await baseQuery
      .select([
        sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("total_cost"),
        sql<number>`coalesce(sum(tokens_in), 0)`.as("total_tokens_in"),
        sql<number>`coalesce(sum(tokens_out), 0)`.as("total_tokens_out"),
        sql<number>`count(*) filter (where event_type = 'llm_call_end')`.as("llm_calls"),
        sql<number>`count(*) filter (where event_type = 'tool_call_end')`.as("tool_calls"),
      ])
      .executeTakeFirstOrThrow()

    const byModel = await this.queryByModelBreakdown({ agentId, since })

    return {
      totalCostUsd: Number(summary.total_cost),
      totalTokensIn: Number(summary.total_tokens_in),
      totalTokensOut: Number(summary.total_tokens_out),
      totalLlmCalls: Number(summary.llm_calls),
      totalToolCalls: Number(summary.tool_calls),
      byModel,
    }
  }

  /**
   * Read cost summary from session columns + event aggregation.
   */
  async getSessionCostSummary(sessionId: string): Promise<CostSummary> {
    const session = await this.db
      .selectFrom("session")
      .select(["total_tokens_in", "total_tokens_out", "total_cost_usd"])
      .where("id", "=", sessionId)
      .executeTakeFirst()

    if (!session) {
      return {
        totalCostUsd: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalLlmCalls: 0,
        totalToolCalls: 0,
        byModel: {},
      }
    }

    const counts = await this.db
      .selectFrom("agent_event")
      .where("session_id", "=", sessionId)
      .select([
        sql<number>`count(*) filter (where event_type = 'llm_call_end')`.as("llm_calls"),
        sql<number>`count(*) filter (where event_type = 'tool_call_end')`.as("tool_calls"),
      ])
      .executeTakeFirstOrThrow()

    const byModel = await this.queryByModelBreakdown({ sessionId })

    return {
      totalCostUsd: Number(session.total_cost_usd),
      totalTokensIn: Number(session.total_tokens_in),
      totalTokensOut: Number(session.total_tokens_out),
      totalLlmCalls: Number(counts.llm_calls),
      totalToolCalls: Number(counts.tool_calls),
      byModel,
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async getDailyCost(agentId: string): Promise<number> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const result = await this.db
      .selectFrom("agent_event")
      .where("agent_id", "=", agentId)
      .where("cost_usd", "is not", null)
      .where("created_at", ">=", today)
      .select(sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("daily_cost"))
      .executeTakeFirstOrThrow()

    return Number(result.daily_cost)
  }

  private async queryByModelBreakdown(filters: {
    agentId?: string
    sessionId?: string
    since?: Date
  }): Promise<CostSummary["byModel"]> {
    let q = this.db.selectFrom("agent_event").where("cost_usd", "is not", null)

    if (filters.agentId) {
      q = q.where("agent_id", "=", filters.agentId)
    }
    if (filters.sessionId) {
      q = q.where("session_id", "=", filters.sessionId)
    }
    if (filters.since) {
      q = q.where("created_at", ">=", filters.since)
    }

    const modelRows = await q
      .select([
        "model",
        sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("cost"),
        sql<number>`coalesce(sum(tokens_in), 0)`.as("tokens_in"),
        sql<number>`coalesce(sum(tokens_out), 0)`.as("tokens_out"),
      ])
      .groupBy("model")
      .execute()

    const byModel: CostSummary["byModel"] = {}
    for (const row of modelRows) {
      byModel[row.model ?? "unknown"] = {
        costUsd: Number(row.cost),
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
      }
    }
    return byModel
  }

  private async emitCostAlert(
    agentId: string,
    jobId: string,
    sessionId: string | null,
    status: BudgetStatus,
  ): Promise<void> {
    if (!this.eventEmitter) return

    await this.eventEmitter.emit({
      agentId,
      jobId,
      sessionId,
      eventType: "cost_alert",
      actor: "system",
      payload: {
        level: status.level,
        exceeded: status.exceeded,
        warning: status.warning,
        currentUsd: status.currentUsd,
        limitUsd: status.limitUsd,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function checkThreshold(
  current: number,
  limit: number,
  warningPct: number,
  level: "job" | "session" | "daily",
): BudgetStatus {
  return {
    exceeded: current > limit,
    warning: !!(current >= limit * warningPct && current <= limit),
    currentUsd: current,
    limitUsd: limit,
    level,
  }
}
