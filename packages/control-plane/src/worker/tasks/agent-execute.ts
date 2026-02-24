/**
 * Main agent execution task — "agent_execute"
 *
 * Receives a job payload from the Graphile Worker queue and drives the
 * job through its lifecycle:
 *   SCHEDULED → RUNNING → COMPLETED | FAILED | TIMED_OUT
 *
 * Execution backend dispatch is a placeholder for now — the actual
 * LLM/tool execution pipeline will be implemented in a later task.
 */

import type { JobHelpers, Task } from "graphile-worker"
import type { Kysely } from "kysely"

import type { Database } from "../../db/types.js"
import { classifyError } from "../error-classifier.js"
import { startHeartbeat } from "../heartbeat.js"
import { calculateRunAt } from "../retry.js"

export interface AgentExecutePayload {
  jobId: string
}

/**
 * Create the agent_execute task handler.
 * Accepts a Kysely database instance via closure for dependency injection.
 */
export function createAgentExecuteTask(db: Kysely<Database>): Task {
  return async (rawPayload: unknown, _helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as AgentExecutePayload
    const { jobId } = payload

    // Load the job and validate it's in SCHEDULED state
    const job = await db.selectFrom("job").selectAll().where("id", "=", jobId).executeTakeFirst()

    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    if (job.status !== "SCHEDULED") {
      // Job is not in the expected state — skip silently.
      // This can happen if the job was cancelled or failed by another process.
      return
    }

    // Transition SCHEDULED → RUNNING
    await db
      .updateTable("job")
      .set({
        status: "RUNNING",
        started_at: new Date(),
        heartbeat_at: new Date(),
        attempt: job.attempt + 1,
      })
      .where("id", "=", jobId)
      .where("status", "=", "SCHEDULED")
      .execute()

    // Start heartbeat writer (updates heartbeat_at every 30s)
    const heartbeat = startHeartbeat(jobId, db)

    try {
      // ── Placeholder: execution backend dispatch ──
      // In the future, this is where we:
      // 1. Load the agent definition and session context
      // 2. Hydrate from checkpoint (if resuming after crash)
      // 3. Enter the agent execution loop (LLM call → tool calls → checkpoint)
      // 4. Stream JSONL events to the session buffer
      //
      // For now, we immediately mark the job as completed.
      // This will be replaced by the actual execution backend in task #5+.

      await db
        .updateTable("job")
        .set({
          status: "COMPLETED",
          completed_at: new Date(),
          result: { placeholder: true, message: "Execution backend not yet implemented" },
        })
        .where("id", "=", jobId)
        .where("status", "=", "RUNNING")
        .execute()
    } catch (err: unknown) {
      // Classify the error to determine retry behavior
      const classification = classifyError(err)

      if (classification.retryable && job.attempt < job.max_attempts) {
        // Transition RUNNING → FAILED (the trigger allows this),
        // then FAILED → RETRYING will be handled by retry scheduling
        await db
          .updateTable("job")
          .set({
            status: "FAILED",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
            },
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()

        // Transition FAILED → RETRYING
        await db
          .updateTable("job")
          .set({ status: "RETRYING" })
          .where("id", "=", jobId)
          .where("status", "=", "FAILED")
          .execute()

        // Re-enqueue via Graphile Worker with backoff delay
        const runAt = calculateRunAt(job.attempt)
        await _helpers.addJob("agent_execute", { jobId }, { runAt, maxAttempts: 1 })

        // Transition RETRYING → SCHEDULED
        await db
          .updateTable("job")
          .set({ status: "SCHEDULED" })
          .where("id", "=", jobId)
          .where("status", "=", "RETRYING")
          .execute()
      } else if (classification.category === "TIMEOUT") {
        await db
          .updateTable("job")
          .set({
            status: "TIMED_OUT",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
            },
            completed_at: new Date(),
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()
      } else {
        // Permanent failure or retries exhausted
        await db
          .updateTable("job")
          .set({
            status: "FAILED",
            error: {
              category: classification.category,
              message: classification.message,
              attempt: job.attempt + 1,
              retriesExhausted: job.attempt >= job.max_attempts,
            },
            completed_at: new Date(),
          })
          .where("id", "=", jobId)
          .where("status", "=", "RUNNING")
          .execute()
      }
    } finally {
      heartbeat.stop()
    }
  }
}
