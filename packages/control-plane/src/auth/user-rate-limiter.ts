import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { Database, RateLimit, TokenBudget } from "../db/types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean
  reason: "allowed" | "rate_limited" | "budget_exceeded"
  replyToUser?: string
  retryAfterSeconds?: number
}

export interface UsageSummary {
  messagesSent: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  windowSeconds: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRateLimit(v: unknown): v is RateLimit {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.max_messages === "number" && typeof r.window_seconds === "number"
}

function isTokenBudget(v: unknown): v is TokenBudget {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.max_tokens === "number" && typeof r.window_seconds === "number"
}

/** Floor a date to the start of its UTC hour. */
function floorToHour(d: Date): Date {
  const floored = new Date(d)
  floored.setUTCMinutes(0, 0, 0)
  return floored
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class UserRateLimiter {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Pre-message check — should the user be allowed to send a new message?
   *
   * Resolution order:
   *   1. grantRateLimit / grantTokenBudget (per-grant override)
   *   2. agent.resource_limits.userRateLimit / userTokenBudget (agent default)
   *   3. No limit (allow)
   */
  async check(
    userAccountId: string,
    agentId: string,
    grantRateLimit?: RateLimit | null,
    grantTokenBudget?: TokenBudget | null,
  ): Promise<RateLimitDecision> {
    // ── Resolve effective limits ──
    const agent = await this.db
      .selectFrom("agent")
      .select(["resource_limits"])
      .where("id", "=", agentId)
      .executeTakeFirst()

    const agentLimits = agent?.resource_limits ?? {}

    const rateLimit =
      grantRateLimit ?? (isRateLimit(agentLimits.userRateLimit) ? agentLimits.userRateLimit : null)

    const tokenBudget =
      grantTokenBudget ??
      (isTokenBudget(agentLimits.userTokenBudget) ? agentLimits.userTokenBudget : null)

    // ── Rate limit check (message count in sliding window) ──
    if (rateLimit) {
      const { count } = await this.db
        .selectFrom("session_message as sm")
        .innerJoin("session as s", "s.id", "sm.session_id")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("s.agent_id", "=", agentId)
        .where("s.user_account_id", "=", userAccountId)
        .where("sm.role", "=", "user")
        .where(
          "sm.created_at",
          ">",
          sql<Date>`now() - make_interval(secs => ${sql.lit(rateLimit.window_seconds)})`,
        )
        .executeTakeFirstOrThrow()

      if (count >= rateLimit.max_messages) {
        return {
          allowed: false,
          reason: "rate_limited",
          replyToUser: `You've reached the message limit (${rateLimit.max_messages} per ${formatWindow(rateLimit.window_seconds)}). Please try again later.`,
          retryAfterSeconds: rateLimit.window_seconds,
        }
      }
    }

    // ── Token budget check (token sum in sliding window from ledger) ──
    if (tokenBudget) {
      const row = await this.db
        .selectFrom("user_usage_ledger")
        .select(sql<number>`coalesce(sum(tokens_in + tokens_out), 0)::int`.as("total_tokens"))
        .where("user_account_id", "=", userAccountId)
        .where("agent_id", "=", agentId)
        .where(
          "period_start",
          ">",
          sql<Date>`now() - make_interval(secs => ${sql.lit(tokenBudget.window_seconds)})`,
        )
        .executeTakeFirstOrThrow()

      if (row.total_tokens >= tokenBudget.max_tokens) {
        return {
          allowed: false,
          reason: "budget_exceeded",
          replyToUser: `You've reached the token budget (${tokenBudget.max_tokens} tokens per ${formatWindow(tokenBudget.window_seconds)}). Please try again later.`,
          retryAfterSeconds: tokenBudget.window_seconds,
        }
      }
    }

    return { allowed: true, reason: "allowed" }
  }

  /**
   * Post-execution usage recording — upserts into the current hourly bucket.
   */
  async recordUsage(
    userAccountId: string,
    agentId: string,
    messageCount: number,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): Promise<void> {
    const now = new Date()
    const periodStart = floorToHour(now)
    const periodEnd = new Date(periodStart.getTime() + 3_600_000)

    await this.db
      .insertInto("user_usage_ledger")
      .values({
        user_account_id: userAccountId,
        agent_id: agentId,
        period_start: periodStart,
        period_end: periodEnd,
        messages_sent: messageCount,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
      })
      .onConflict((oc) =>
        oc.columns(["user_account_id", "agent_id", "period_start"]).doUpdateSet({
          messages_sent: sql`user_usage_ledger.messages_sent + excluded.messages_sent`,
          tokens_in: sql`user_usage_ledger.tokens_in + excluded.tokens_in`,
          tokens_out: sql`user_usage_ledger.tokens_out + excluded.tokens_out`,
          cost_usd: sql`user_usage_ledger.cost_usd + excluded.cost_usd`,
        }),
      )
      .execute()
  }

  /**
   * Aggregate usage for a user+agent within a time window.
   */
  async getUsageSummary(
    userAccountId: string,
    agentId: string,
    windowSeconds: number,
  ): Promise<UsageSummary> {
    const row = await this.db
      .selectFrom("user_usage_ledger")
      .select([
        sql<number>`coalesce(sum(messages_sent), 0)::int`.as("messages_sent"),
        sql<number>`coalesce(sum(tokens_in), 0)::int`.as("tokens_in"),
        sql<number>`coalesce(sum(tokens_out), 0)::int`.as("tokens_out"),
        sql<number>`coalesce(sum(cost_usd), 0)::numeric(12,6)`.as("cost_usd"),
      ])
      .where("user_account_id", "=", userAccountId)
      .where("agent_id", "=", agentId)
      .where(
        "period_start",
        ">",
        sql<Date>`now() - make_interval(secs => ${sql.lit(windowSeconds)})`,
      )
      .executeTakeFirstOrThrow()

    return {
      messagesSent: Number(row.messages_sent),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      costUsd: Number(row.cost_usd),
      windowSeconds,
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

function formatWindow(seconds: number): string {
  if (seconds >= 86_400) {
    const days = Math.floor(seconds / 86_400)
    return days === 1 ? "day" : `${days} days`
  }
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600)
    return hours === 1 ? "hour" : `${hours} hours`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes === 1 ? "minute" : `${minutes} minutes`
}
