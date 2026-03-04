/**
 * Event Retention Pruning Task — "prune_agent_events"
 *
 * Scheduled to run daily at 03:00 UTC to prune old agent events
 * based on configurable retention policies.
 *
 * Retention rules:
 * - General events older than `defaultDays` (30) are deleted.
 * - Cost events (cost_usd IS NOT NULL) older than `costEventDays` (90) are deleted.
 * - Processes in batches of `batchSize` (1000) to avoid long locks.
 *
 * This task is idempotent — running it multiple times is safe because
 * it deletes by age threshold and processes in bounded batches.
 */

import type { Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database } from "../../db/types.js"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface EventRetentionConfig {
  /** Days to retain general (non-cost) events. Default: 30 */
  defaultDays?: number
  /** Days to retain cost events (cost_usd IS NOT NULL). Default: 90 */
  costEventDays?: number
  /** Max rows to delete per execution cycle. Default: 1000 */
  batchSize?: number
}

export interface PruneResult {
  /** Number of general events pruned */
  generalPruned: number
  /** Number of cost events pruned */
  costPruned: number
}

// ──────────────────────────────────────────────────
// Pipeline core (exported for testing)
// ──────────────────────────────────────────────────

/**
 * Run the event retention pruning pipeline.
 *
 * Deletes general events older than `defaultDays` and cost events
 * older than `costEventDays`, each capped at `batchSize` rows.
 */
export async function runPruneAgentEvents(
  db: Kysely<Database>,
  config: EventRetentionConfig = {},
): Promise<PruneResult> {
  const defaultDays = config.defaultDays ?? 30
  const costEventDays = config.costEventDays ?? 90
  const batchSize = config.batchSize ?? 1000

  const generalCutoff = new Date()
  generalCutoff.setUTCDate(generalCutoff.getUTCDate() - defaultDays)

  const costCutoff = new Date()
  costCutoff.setUTCDate(costCutoff.getUTCDate() - costEventDays)

  // 1. Delete general events (non-cost) older than defaultDays
  const generalResult = await db
    .deleteFrom("agent_event")
    .where("id", "in", (qb) =>
      qb
        .selectFrom("agent_event")
        .select("id")
        .where("created_at", "<", generalCutoff)
        .where("cost_usd", "is", null)
        .limit(batchSize),
    )
    .executeTakeFirst()

  const generalPruned = Number(generalResult.numDeletedRows)

  // 2. Delete cost events older than costEventDays
  const costResult = await db
    .deleteFrom("agent_event")
    .where("id", "in", (qb) =>
      qb
        .selectFrom("agent_event")
        .select("id")
        .where("created_at", "<", costCutoff)
        .where("cost_usd", "is not", null)
        .limit(batchSize),
    )
    .executeTakeFirst()

  const costPruned = Number(costResult.numDeletedRows)

  return { generalPruned, costPruned }
}

// ──────────────────────────────────────────────────
// Task factory
// ──────────────────────────────────────────────────

/**
 * Create the prune_agent_events task handler.
 */
export function createPruneAgentEventsTask(
  db: Kysely<Database>,
  config?: EventRetentionConfig,
): Task {
  return async (_payload: unknown, helpers): Promise<void> => {
    const result = await runPruneAgentEvents(db, config)

    const total = result.generalPruned + result.costPruned

    if (total > 0) {
      helpers.logger.info(
        `prune_agent_events: pruned ${total} event(s) — ` +
          `general=${result.generalPruned} cost=${result.costPruned}`,
      )
    } else {
      helpers.logger.info("prune_agent_events: no events to prune")
    }
  }
}
