/**
 * Correction strengthening task — "correction_strengthen"
 *
 * Detects clusters of similar user corrections and proposes
 * rule strengthening when 3+ similar corrections exist.
 *
 * Maps to §17 Memory Extraction Pipeline: corrections as input,
 * strengthened policy proposals as output.
 */

import type {
  CorrectionStrengthenerConfig,
  EmbeddingFn,
  FeedbackEntry,
  RuleSynthesizer,
  StrengtheningResult,
} from "@cortex/shared/correction-strengthener"
import { runCorrectionStrengthener } from "@cortex/shared/correction-strengthener"
import { CortexAttributes, withSpan } from "@cortex/shared/tracing"
import type { JobHelpers, Task } from "graphile-worker"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface CorrectionStrengthenPayload {
  agentId: string
  feedback: FeedbackEntry[]
  config?: CorrectionStrengthenerConfig
}

export interface CorrectionStrengthenDeps {
  embed: EmbeddingFn
  synthesize: RuleSynthesizer
}

// ──────────────────────────────────────────────────
// Task factory
// ──────────────────────────────────────────────────

/**
 * Create the correction_strengthen task handler.
 * Accepts dependencies for embedding and rule synthesis.
 */
export function createCorrectionStrengthenTask(deps?: CorrectionStrengthenDeps): Task {
  return async (rawPayload: unknown, helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as CorrectionStrengthenPayload
    const { agentId, feedback, config } = payload

    helpers.logger.info(
      `correction_strengthen: received ${feedback.length} feedback entries for agent ${agentId}`,
    )

    if (!deps) {
      helpers.logger.info(
        `correction_strengthen: no deps configured, skipping (no-op) for agent ${agentId}`,
      )
      return
    }

    if (feedback.length === 0) {
      helpers.logger.info(`correction_strengthen: no feedback entries for agent ${agentId}`)
      return
    }

    try {
      const result = await runCorrectionStrengthenPipeline(agentId, feedback, deps, config)

      helpers.logger.info(
        `correction_strengthen: completed for agent ${agentId} — ` +
          `proposals=${result.proposals.length} clusters=${result.clustersFound} ` +
          `qualifying=${result.clustersAboveThreshold}`,
      )
    } catch (err) {
      helpers.logger.error(
        `correction_strengthen: failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }
}

// ──────────────────────────────────────────────────
// Pipeline wrapper with tracing
// ──────────────────────────────────────────────────

export async function runCorrectionStrengthenPipeline(
  agentId: string,
  feedback: FeedbackEntry[],
  deps: CorrectionStrengthenDeps,
  config?: CorrectionStrengthenerConfig,
): Promise<StrengtheningResult> {
  return withSpan("cortex.correction.strengthen", async (span) => {
    span.setAttribute(CortexAttributes.AGENT_ID, agentId)
    span.setAttribute("cortex.correction.feedback_count", feedback.length)

    const result = await runCorrectionStrengthener(feedback, deps, config)

    span.setAttribute("cortex.correction.proposals", result.proposals.length)
    span.setAttribute("cortex.correction.clusters_found", result.clustersFound)
    span.setAttribute("cortex.correction.clusters_qualifying", result.clustersAboveThreshold)

    return result
  })
}
