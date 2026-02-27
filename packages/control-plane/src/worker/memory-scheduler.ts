import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { MemoryExtractPayload } from "./tasks/memory-extract.js"

export interface JobQueue {
  addJob(
    identifier: string,
    payload: unknown,
    spec?: {
      jobKey?: string
      runAt?: Date
      maxAttempts?: number
    },
  ): Promise<unknown>
}

export interface MemoryMessageInput {
  sessionId: string
  agentId: string
  role: "user" | "assistant" | "system"
  content: string
  occurredAt?: string
}

export interface MemorySchedulerOptions {
  db: Kysely<Database>
  threshold: number
}

export interface MemoryScheduler {
  recordMessage(message: MemoryMessageInput, queue: JobQueue): Promise<void>
  flushSession(sessionId: string, queue: JobQueue): Promise<void>
  flushAllPending(queue: JobQueue): Promise<number>
}

interface PendingWindow {
  agentId: string
  upToMessageId: string
  messages: MemoryExtractPayload["messages"]
}

function normalizeThreshold(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 50
}

function buildJobKey(sessionId: string, upToMessageId: string): string {
  return `memory-extract:${sessionId}:${upToMessageId}`
}

async function loadPendingWindow(
  db: Kysely<Database>,
  sessionId: string,
): Promise<PendingWindow | null> {
  const pendingRows = await db
    .selectFrom("memory_extract_message")
    .select(["id", "agent_id", "role", "content", "occurred_at"])
    .where("session_id", "=", sessionId)
    .where("extracted_at", "is", null)
    .orderBy("id", "asc")
    .execute()

  if (pendingRows.length === 0) {
    return null
  }

  const last = pendingRows[pendingRows.length - 1]!
  return {
    agentId: last.agent_id,
    upToMessageId: String(last.id),
    messages: pendingRows.map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.occurred_at.toISOString(),
    })),
  }
}

async function enqueuePendingWindow(
  db: Kysely<Database>,
  queue: JobQueue,
  sessionId: string,
): Promise<boolean> {
  const window = await loadPendingWindow(db, sessionId)
  if (!window) {
    return false
  }

  const payload: MemoryExtractPayload = {
    sessionId,
    agentId: window.agentId,
    upToMessageId: window.upToMessageId,
    messages: window.messages,
  }

  await queue.addJob("memory_extract", payload, {
    jobKey: buildJobKey(sessionId, window.upToMessageId),
    maxAttempts: 1,
  })
  return true
}

export function createMemoryScheduler(options: MemorySchedulerOptions): MemoryScheduler {
  const threshold = normalizeThreshold(options.threshold)

  return {
    async recordMessage(message: MemoryMessageInput, queue: JobQueue): Promise<void> {
      const occurredAt = message.occurredAt ? new Date(message.occurredAt) : new Date()

      await options.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("memory_extract_message")
          .values({
            session_id: message.sessionId,
            agent_id: message.agentId,
            role: message.role,
            content: message.content,
            occurred_at: occurredAt,
          })
          .executeTakeFirstOrThrow()

        await trx
          .insertInto("memory_extract_session_state")
          .values({
            session_id: message.sessionId,
            pending_count: 1,
            total_count: 1,
          })
          .onConflict((oc) =>
            oc.column("session_id").doUpdateSet((eb) => ({
              pending_count: eb("memory_extract_session_state.pending_count", "+", 1),
              total_count: eb("memory_extract_session_state.total_count", "+", 1),
              updated_at: new Date(),
            })),
          )
          .executeTakeFirstOrThrow()
      })

      const state = await options.db
        .selectFrom("memory_extract_session_state")
        .select("pending_count")
        .where("session_id", "=", message.sessionId)
        .executeTakeFirst()

      if (!state || state.pending_count < threshold) {
        return
      }

      await enqueuePendingWindow(options.db, queue, message.sessionId)
    },

    async flushSession(sessionId: string, queue: JobQueue): Promise<void> {
      await enqueuePendingWindow(options.db, queue, sessionId)
    },

    async flushAllPending(queue: JobQueue): Promise<number> {
      const sessions = await options.db
        .selectFrom("memory_extract_session_state")
        .select("session_id")
        .where("pending_count", ">", 0)
        .execute()

      for (const session of sessions) {
        await enqueuePendingWindow(options.db, queue, session.session_id)
      }

      return sessions.length
    },
  }
}
