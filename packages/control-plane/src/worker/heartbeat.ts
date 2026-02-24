/**
 * Heartbeat monitor for running jobs.
 *
 * - startHeartbeat: writes heartbeat_at every 30s while a job is RUNNING
 * - stopHeartbeat: clears the interval
 * - reapZombieJobs: finds jobs where heartbeat_at is stale (>90s) and transitions to FAILED
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

/** Heartbeat interval: 30 seconds */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Zombie threshold: jobs with heartbeat older than 90 seconds are considered dead */
export const ZOMBIE_THRESHOLD_MS = 90_000

export interface HeartbeatHandle {
  stop: () => void
}

/**
 * Start a heartbeat writer that updates heartbeat_at every 30s for the given job.
 * Returns a handle to stop the heartbeat when the job completes.
 */
export function startHeartbeat(jobId: string, db: Kysely<Database>): HeartbeatHandle {
  const interval = setInterval(() => {
    void db
      .updateTable("job")
      .set({ heartbeat_at: new Date() })
      .where("id", "=", jobId)
      .where("status", "=", "RUNNING")
      .execute()
      .catch(() => {
        // Swallow heartbeat write failures — the zombie reaper will catch stale jobs.
        // Logging is handled at the caller level.
      })
  }, HEARTBEAT_INTERVAL_MS)

  return {
    stop() {
      clearInterval(interval)
    },
  }
}

/**
 * Reaper query: find RUNNING jobs where heartbeat_at < NOW() - threshold
 * and transition them to FAILED.
 *
 * This is intended to be called periodically (e.g., every 60s) by a
 * Graphile Worker cron task or external scheduler.
 */
export async function reapZombieJobs(db: Kysely<Database>): Promise<number> {
  const threshold = new Date(Date.now() - ZOMBIE_THRESHOLD_MS)

  const result = await db
    .updateTable("job")
    .set({
      status: "FAILED",
      error: { reason: "zombie", message: "Job heartbeat stale — presumed dead" },
      completed_at: new Date(),
    })
    .where("status", "=", "RUNNING")
    .where((eb) => eb.or([eb("heartbeat_at", "<", threshold), eb("heartbeat_at", "is", null)]))
    .executeTakeFirst()

  return Number(result.numUpdatedRows)
}
