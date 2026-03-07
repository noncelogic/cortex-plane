/**
 * Event Retention Pruning Task — "prune_agent_events"
 *
 * Graphile Worker cron task: runs daily at 03:00 UTC.
 *
 * Deletes agent_event rows past their retention window:
 *   1. Non-cost events older than `defaultDays` (default 30).
 *   2. Cost events (cost_usd IS NOT NULL) older than `costEventDays` (default 90).
 *
 * Each category is capped at `batchSize` (default 1000) deletes per invocation
 * to avoid long-held locks.
 *
 * Idempotent — safe to run multiple times.
 *
 * @see https://github.com/noncelogic/cortex-plane/issues/330
 */

import type { JobHelpers, Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database } from "../../db/types.js"

export interface EventRetentionConfig {
  /** Max age for non-cost events (days). Default 30. */
  defaultDays?: number
  /** Max age for cost events (days). Default 90. */
  costEventDays?: number
  /** Max rows deleted per category per run. Default 1000. */
  batchSize?: number
}

export function createPruneAgentEventsTask(
  db: Kysely<Database>,
  config?: EventRetentionConfig,
): Task {
  const defaultDays = config?.defaultDays ?? 30
  const costEventDays = config?.costEventDays ?? 90
  const batchSize = config?.batchSize ?? 1000

  return async (_payload: unknown, helpers: JobHelpers): Promise<void> => {
    const now = new Date()

    const defaultCutoff = new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000)
    const costCutoff = new Date(now.getTime() - costEventDays * 24 * 60 * 60 * 1000)

    // 1. Prune non-cost events older than defaultDays
    const defaultResult = await db
      .deleteFrom("agent_event")
      .where(
        "id",
        "in",
        db
          .selectFrom("agent_event")
          .select("id")
          .where("created_at", "<", defaultCutoff)
          .where("cost_usd", "is", null)
          .limit(batchSize),
      )
      .executeTakeFirst()

    const defaultPruned = Number(defaultResult.numDeletedRows)

    // 2. Prune cost events older than costEventDays
    const costResult = await db
      .deleteFrom("agent_event")
      .where(
        "id",
        "in",
        db
          .selectFrom("agent_event")
          .select("id")
          .where("created_at", "<", costCutoff)
          .where("cost_usd", "is not", null)
          .limit(batchSize),
      )
      .executeTakeFirst()

    const costPruned = Number(costResult.numDeletedRows)

    const total = defaultPruned + costPruned
    if (total > 0) {
      helpers.logger.info(
        `prune_agent_events: deleted ${total} events (${defaultPruned} default, ${costPruned} cost)`,
      )
    }
  }
}
