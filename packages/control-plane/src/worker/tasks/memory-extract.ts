/**
 * Memory extraction task — "memory_extract"
 *
 * Placeholder for the Tier 3 extraction pipeline (spec §17).
 * Receives a session_id + message batch and will eventually call
 * an extraction model to produce MemoryRecords for Qdrant upsert.
 *
 * Trigger conditions (from spec):
 * 1. Session buffer accumulates 50 new messages, OR
 * 2. Session gracefully terminates
 *
 * The actual extraction model call is NOT implemented yet —
 * this is the task skeleton that will be filled in a later task.
 */

import type { JobHelpers, Task } from "graphile-worker"

export interface MemoryExtractPayload {
  sessionId: string
  agentId: string
  messages: Array<{
    role: string
    content: string
    timestamp: string
  }>
}

/**
 * Create the memory_extract task handler.
 * The extraction pipeline will be implemented when the LLM client
 * and Qdrant upsert logic are integrated.
 */
export function createMemoryExtractTask(): Task {
  return (rawPayload: unknown, helpers: JobHelpers): void => {
    const payload = rawPayload as MemoryExtractPayload
    const { sessionId, agentId, messages } = payload

    helpers.logger.info(
      `memory_extract: received ${messages.length} messages for session ${sessionId} (agent ${agentId})`,
    )

    // ── Placeholder: extraction pipeline ──
    // Future implementation will:
    // 1. Retrieve existing memories from Qdrant for deduplication context
    // 2. Call extraction model (Claude Haiku / GPT-4o-mini) with the message batch
    // 3. Validate extracted MemoryRecords against schema (Zod)
    // 4. Deduplicate: cosine similarity >0.95 → discard
    // 5. Supersession: similarity 0.85-0.95 with contradictory content → mark superseded
    // 6. Embed extracted facts via text-embedding-3-small
    // 7. Upsert to Qdrant collection for this agent
    //
    // For now, this task completes immediately as a no-op.

    helpers.logger.info(`memory_extract: completed (no-op) for session ${sessionId}`)
  }
}
