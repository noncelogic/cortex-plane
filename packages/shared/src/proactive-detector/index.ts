export { correlateSignals, tokenize } from "./correlator.js"
export { persistSignals } from "./persist.js"
export type { ProactiveDetectorDeps } from "./pipeline.js"
export { runProactiveDetector } from "./pipeline.js"
export type {
  DetectionResult,
  ProactiveDetectorConfig,
  ProactiveTask,
  Severity,
  Signal,
  SignalCollector,
  SignalPersistence,
  SignalSource,
  Suggestion,
} from "./types.js"
export { SeveritySchema, SignalSchema, SignalSourceSchema } from "./types.js"
