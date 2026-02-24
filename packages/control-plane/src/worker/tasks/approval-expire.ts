/**
 * Approval Expiry Task — "approval_expire"
 *
 * Scheduled to run periodically (every 60 seconds) to detect and expire
 * stale approval requests that have passed their expires_at timestamp.
 *
 * For each expired request:
 * 1. Marks the approval_request as EXPIRED
 * 2. Transitions the associated job to FAILED
 * 3. Writes an audit log entry
 *
 * This task is idempotent — running it multiple times is safe because
 * the UPDATE uses WHERE status = 'PENDING' as a guard.
 */

import type { Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database } from "../../db/types.js"
import { ApprovalService } from "../../approval/service.js"

/**
 * Create the approval_expire task handler.
 */
export function createApprovalExpireTask(db: Kysely<Database>): Task {
  const approvalService = new ApprovalService({ db })

  return async (): Promise<void> => {
    const expiredCount = await approvalService.expireStaleRequests()

    if (expiredCount > 0) {
      // In production, Pino logger would capture this.
      // The task is typically invoked by a Graphile Worker cron schedule.
      console.info(`[approval_expire] Expired ${expiredCount} stale approval request(s)`)
    }
  }
}
