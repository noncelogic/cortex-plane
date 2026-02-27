/**
 * Proactive detection task — "proactive_detect"
 *
 * Cross-correlates multiple signal sources to surface
 * actionable insights before the user asks.
 *
 * Maps to §11 Orchestration: extends proactive scheduling
 * beyond cron-based triggers into intelligent multi-source
 * signal correlation.
 */

import type {
  DetectionResult,
  ProactiveDetectorConfig,
  SignalCollector,
  SignalPersistence,
} from "@cortex/shared/proactive-detector"
import { runProactiveDetector } from "@cortex/shared/proactive-detector"
import { CortexAttributes, withSpan } from "@cortex/shared/tracing"
import type { JobHelpers, Task } from "graphile-worker"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface ProactiveDetectPayload {
  agentId: string
  config?: ProactiveDetectorConfig
}

export interface ProactiveDetectDeps {
  collectors: SignalCollector[]
  store: SignalPersistence
}

// ──────────────────────────────────────────────────
// Task factory
// ──────────────────────────────────────────────────

/**
 * Create the proactive_detect task handler.
 * Accepts dependencies for signal collection and persistence.
 */
export function createProactiveDetectTask(deps?: ProactiveDetectDeps): Task {
  return async (rawPayload: unknown, helpers: JobHelpers): Promise<void> => {
    const payload = rawPayload as ProactiveDetectPayload
    const { agentId, config } = payload

    helpers.logger.info(`proactive_detect: starting detection sweep for agent ${agentId}`)

    if (!deps) {
      helpers.logger.info(
        `proactive_detect: no deps configured, skipping (no-op) for agent ${agentId}`,
      )
      return
    }

    if (deps.collectors.length === 0) {
      helpers.logger.info(`proactive_detect: no collectors registered for agent ${agentId}`)
      return
    }

    try {
      const result = await runProactiveDetectPipeline(agentId, deps, config)

      helpers.logger.info(
        `proactive_detect: completed for agent ${agentId} — ` +
          `collected=${result.signalsCollected} cross=${result.crossSignals} ` +
          `persisted=${result.persisted} tasks=${result.tasksCreated}`,
      )
    } catch (err) {
      helpers.logger.error(
        `proactive_detect: failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }
}

// ──────────────────────────────────────────────────
// Pipeline wrapper with tracing
// ──────────────────────────────────────────────────

export async function runProactiveDetectPipeline(
  agentId: string,
  deps: ProactiveDetectDeps,
  config?: ProactiveDetectorConfig,
): Promise<DetectionResult> {
  return withSpan("cortex.proactive.detect", async (span) => {
    span.setAttribute(CortexAttributes.AGENT_ID, agentId)
    span.setAttribute("cortex.proactive.collector_count", deps.collectors.length)

    const result = await runProactiveDetector(deps, config)

    span.setAttribute("cortex.proactive.signals_collected", result.signalsCollected)
    span.setAttribute("cortex.proactive.cross_signals", result.crossSignals)
    span.setAttribute("cortex.proactive.persisted", result.persisted)
    span.setAttribute("cortex.proactive.tasks_created", result.tasksCreated)

    return result
  })
}
