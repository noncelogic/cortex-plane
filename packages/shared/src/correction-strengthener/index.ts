export { buildClusters, clusterConfidence, clusterIndices } from "./clustering.js"
export type { CorrectionStrengthenerDeps } from "./proposals.js"
export { buildProposals, inferTargetFile, runCorrectionStrengthener } from "./proposals.js"
export type {
  CorrectionStrengthenerConfig,
  EmbeddingFn,
  FeedbackCluster,
  FeedbackEntry,
  RuleProposal,
  RuleSynthesizer,
  StrengtheningResult,
} from "./types.js"
export { FeedbackEntrySchema } from "./types.js"
