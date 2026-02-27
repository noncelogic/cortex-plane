/**
 * Council Expiry Task — "council_expire"
 *
 * Scheduled to run periodically to detect and expire
 * stale council sessions that have passed their expires_at timestamp.
 */

import type { Task } from "graphile-worker"
import type { Kysely } from "kysely"

import { CouncilService } from "../../council/service.js"
import type { Database } from "../../db/types.js"
import type { SSEConnectionManager } from "../../streaming/manager.js"

export function createCouncilExpireTask(
  db: Kysely<Database>,
  sseManager?: SSEConnectionManager,
): Task {
  const councilService = new CouncilService({ db, sseManager })

  return async (): Promise<void> => {
    const expiredCount = await councilService.expireStaleSessions()

    if (expiredCount > 0) {
      console.info(`[council_expire] Expired ${expiredCount} stale council session(s)`)
    }
  }
}
