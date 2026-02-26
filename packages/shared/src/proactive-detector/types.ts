import { z } from "zod"

// ──────────────────────────────────────────────────
// Signal sources
// ──────────────────────────────────────────────────

export const SignalSourceSchema = z.enum([
  "calendar",
  "portfolio",
  "email",
  "behavioral",
  "cross_signal",
])

export type SignalSource = z.infer<typeof SignalSourceSchema>

// ──────────────────────────────────────────────────
// Severity levels
// ──────────────────────────────────────────────────

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"])

export type Severity = z.infer<typeof SeveritySchema>

// ──────────────────────────────────────────────────
// Signal — the core detection unit
// ──────────────────────────────────────────────────

export const SignalSchema = z.object({
  source: SignalSourceSchema,
  signalType: z.string().min(1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  severity: SeveritySchema,
  /** Whether this signal represents a positive opportunity (vs. a risk/alert). */
  opportunity: z.boolean(),
  /** Optional fingerprint for deduplication. */
  fingerprint: z.string().optional(),
  /** Timestamp when the signal was detected. */
  detectedAt: z.string().optional(),
})

export type Signal = z.infer<typeof SignalSchema>

// ──────────────────────────────────────────────────
// Collector interface — per-source signal gatherers
// ──────────────────────────────────────────────────

export interface SignalCollector {
  readonly source: SignalSource
  collect(): Promise<Signal[]>
}

// ──────────────────────────────────────────────────
// Suggestion — persisted output
// ──────────────────────────────────────────────────

export interface Suggestion {
  signalId: string
  signal: Signal
  createdAt: number
}

// ──────────────────────────────────────────────────
// Task creation request
// ──────────────────────────────────────────────────

export interface ProactiveTask {
  title: string
  description: string
  priority: number
  signalId: string
}

// ──────────────────────────────────────────────────
// Persistence interface (injected for testability)
// ──────────────────────────────────────────────────

export interface SignalPersistence {
  /** Insert a signal if no duplicate fingerprint exists. Returns the signal ID. */
  insertSignalIfNew(signal: Signal): Promise<string | null>
  /** Create a suggestion record linked to a signal. */
  createSuggestion(signalId: string, signal: Signal): Promise<void>
  /** Create a task from a high-confidence signal. */
  createTask(task: ProactiveTask): Promise<void>
}

// ──────────────────────────────────────────────────
// Pipeline configuration
// ──────────────────────────────────────────────────

export interface ProactiveDetectorConfig {
  /** Minimum confidence to persist a signal. Default: 0.5. */
  minConfidence?: number
  /** Minimum confidence to auto-create a task. Default: 0.82. */
  taskCreationThreshold?: number
  /** Whether to auto-create tasks for high-confidence signals. Default: false. */
  createTasks?: boolean
  /** Minimum overlapping tokens for cross-signal correlation. Default: 2. */
  minOverlapTokens?: number
}

// ──────────────────────────────────────────────────
// Pipeline result
// ──────────────────────────────────────────────────

export interface DetectionResult {
  signalsCollected: number
  crossSignals: number
  persisted: number
  tasksCreated: number
}
