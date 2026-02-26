/**
 * Memory extraction task — "memory_extract"
 *
 * Full extraction pipeline (issue #94):
 * 1. Receive session messages from job payload
 * 2. Build extraction prompt
 * 3. Call LLM for structured extraction
 * 4. Validate response with Zod
 * 5. Dedup/supersede against Qdrant
 * 6. Upsert novel facts
 * 7. Return extraction summary
 */

import {
  type AtomicFact,
  ExtractionResponseSchema,
  type ExtractionSummary,
  MemoryService,
  type MemoryStore,
} from "@cortex/shared/memory"
import { CortexAttributes, withSpan } from "@cortex/shared/tracing"
import type { JobHelpers, Task } from "graphile-worker"

import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  type Message,
} from "../../memory/extraction-prompt.js"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

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
 * LLM caller abstraction — takes system + user prompts, returns text.
 * Injected for testability (mock in tests, real provider in prod).
 */
export type LLMCaller = (systemPrompt: string, userPrompt: string) => Promise<string>

/**
 * Embedding function — takes text, returns vector.
 * Injected for testability (mock returns random vectors).
 */
export type EmbeddingFn = (text: string) => Promise<number[]>

export interface MemoryExtractDeps {
  memoryStore: MemoryStore
  llmCall: LLMCaller
  embed: EmbeddingFn
}

// ──────────────────────────────────────────────────
// Pipeline core (exported for testing)
// ──────────────────────────────────────────────────

/**
 * Parse LLM response text into validated AtomicFact[].
 * Handles both raw JSON and markdown-fenced JSON.
 */
export function parseExtractionResponse(text: string): AtomicFact[] {
  // Strip markdown code fences if present
  let cleaned = text.trim()
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m)
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim()
  }

  const parsed: unknown = JSON.parse(cleaned)
  const validated = ExtractionResponseSchema.parse(parsed)
  return validated.facts
}

/**
 * Run the full extraction pipeline for a set of messages.
 */
export async function runExtractionPipeline(
  sessionId: string,
  agentId: string,
  messages: Message[],
  deps: MemoryExtractDeps,
): Promise<ExtractionSummary> {
  const summary: ExtractionSummary = { extracted: 0, deduped: 0, superseded: 0, failed: 0 }

  return withSpan("cortex.memory.extract", async (span) => {
    span.setAttribute(CortexAttributes.AGENT_ID, agentId)
    span.setAttribute("cortex.memory.session_id", sessionId)
    span.setAttribute("cortex.memory.message_count", messages.length)

    // 1. Build prompts
    const systemPrompt = buildExtractionSystemPrompt()
    const userPrompt = buildExtractionUserPrompt(sessionId, messages)

    // 2. Call LLM
    let facts: AtomicFact[]
    try {
      const response = await withSpan("cortex.memory.llm_call", async () => {
        return deps.llmCall(systemPrompt, userPrompt)
      })

      // 3. Parse and validate
      facts = parseExtractionResponse(response)
      summary.extracted = facts.length
      span.setAttribute("cortex.memory.facts_extracted", facts.length)
    } catch (err) {
      span.setAttribute("cortex.memory.extraction_error", String(err))
      throw err
    }

    // 4. Dedup, supersede, and store each fact
    const service = new MemoryService(deps.memoryStore)

    for (const fact of facts) {
      try {
        const embedding = await deps.embed(fact.content)
        const result = await service.store(fact, embedding)

        switch (result.outcome) {
          case "deduped":
            summary.deduped++
            break
          case "superseded":
            summary.superseded++
            break
          case "inserted":
            // already counted in extracted
            break
        }
      } catch {
        summary.failed++
      }
    }

    span.setAttribute("cortex.memory.deduped", summary.deduped)
    span.setAttribute("cortex.memory.superseded", summary.superseded)
    span.setAttribute("cortex.memory.failed", summary.failed)
    span.setAttribute(
      "cortex.memory.inserted",
      summary.extracted - summary.deduped - summary.superseded - summary.failed,
    )

    return summary
  })
}

// ──────────────────────────────────────────────────
// Task factory
// ──────────────────────────────────────────────────

/**
 * Create the memory_extract task handler.
 * Accepts dependencies for LLM calling, embedding, and storage.
 */
export function createMemoryExtractTask(deps?: MemoryExtractDeps): Task {
  return async (rawPayload: unknown, helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as MemoryExtractPayload
    const { sessionId, agentId, messages } = payload

    helpers.logger.info(
      `memory_extract: received ${messages.length} messages for session ${sessionId} (agent ${agentId})`,
    )

    if (!deps) {
      helpers.logger.info(`memory_extract: no deps configured, skipping (no-op) for ${sessionId}`)
      return
    }

    if (messages.length === 0) {
      helpers.logger.info(`memory_extract: no messages to extract for ${sessionId}`)
      return
    }

    try {
      const summary = await runExtractionPipeline(sessionId, agentId, messages, deps)

      helpers.logger.info(
        `memory_extract: completed for ${sessionId} — ` +
          `extracted=${summary.extracted} deduped=${summary.deduped} ` +
          `superseded=${summary.superseded} failed=${summary.failed}`,
      )
    } catch (err) {
      helpers.logger.error(
        `memory_extract: failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }
}
