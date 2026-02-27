import type {
  DetectionResult,
  ProactiveDetectorConfig,
  Signal,
  SignalPersistence,
} from "./types.js"

// ──────────────────────────────────────────────────
// Confidence gating + persistence
// ──────────────────────────────────────────────────

const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_TASK_THRESHOLD = 0.82

/**
 * Persist qualifying signals through confidence gating.
 *
 * For each signal above minConfidence:
 * 1. Insert if fingerprint is new (dedup)
 * 2. Create a suggestion record
 * 3. Optionally create a task for high-confidence signals
 */
export async function persistSignals(
  signals: Signal[],
  store: SignalPersistence,
  config: ProactiveDetectorConfig = {},
): Promise<Pick<DetectionResult, "persisted" | "tasksCreated">> {
  const minConf = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const taskThreshold = config.taskCreationThreshold ?? DEFAULT_TASK_THRESHOLD
  const createTasks = config.createTasks ?? false

  let persisted = 0
  let tasksCreated = 0

  for (const signal of signals) {
    if (signal.confidence < minConf) continue

    const signalId = await store.insertSignalIfNew(signal)
    if (!signalId) continue // duplicate fingerprint

    await store.createSuggestion(signalId, signal)
    persisted++

    if (createTasks && signal.confidence >= taskThreshold) {
      await store.createTask({
        title: `Proactive: ${signal.title}`,
        description: signal.summary,
        priority: signal.severity === "critical" ? 1 : signal.severity === "high" ? 2 : 3,
        signalId,
      })
      tasksCreated++
    }
  }

  return { persisted, tasksCreated }
}
