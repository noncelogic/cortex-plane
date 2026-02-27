import { correlateSignals } from "./correlator.js"
import { persistSignals } from "./persist.js"
import type {
  DetectionResult,
  ProactiveDetectorConfig,
  SignalCollector,
  SignalPersistence,
} from "./types.js"

// ──────────────────────────────────────────────────
// Full proactive detection pipeline
// ──────────────────────────────────────────────────

export interface ProactiveDetectorDeps {
  collectors: SignalCollector[]
  store: SignalPersistence
}

/**
 * Run the full proactive detection pipeline.
 *
 * 1. Collect signals from all registered sources
 * 2. Cross-correlate for multi-source patterns
 * 3. Persist qualifying signals with confidence gating
 */
export async function runProactiveDetector(
  deps: ProactiveDetectorDeps,
  config: ProactiveDetectorConfig = {},
): Promise<DetectionResult> {
  const minOverlap = config.minOverlapTokens ?? 2

  // 1. Collect from all sources
  const allSignals = []
  for (const collector of deps.collectors) {
    const signals = await collector.collect()
    allSignals.push(...signals)
  }

  // 2. Cross-correlate
  const crossSignals = correlateSignals(allSignals, minOverlap)
  const combined = [...allSignals, ...crossSignals]

  // 3. Persist with confidence gating
  const { persisted, tasksCreated } = await persistSignals(combined, deps.store, config)

  return {
    signalsCollected: allSignals.length,
    crossSignals: crossSignals.length,
    persisted,
    tasksCreated,
  }
}
