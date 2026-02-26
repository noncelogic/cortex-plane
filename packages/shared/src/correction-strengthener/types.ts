import { z } from "zod"

// ──────────────────────────────────────────────────
// Feedback entry — input to the correction pipeline
// ──────────────────────────────────────────────────

export const FeedbackEntrySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(5000),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string(),
  /** Optional target file path extracted from context. */
  targetFile: z.string().optional(),
})

export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>

// ──────────────────────────────────────────────────
// Cluster — group of similar feedback entries
// ──────────────────────────────────────────────────

export interface FeedbackCluster {
  /** Indices into the original feedback array. */
  indices: number[]
  /** Average pairwise cosine similarity within the cluster. */
  avgSimilarity: number
}

// ──────────────────────────────────────────────────
// Rule proposal — output of the strengthening pipeline
// ──────────────────────────────────────────────────

export interface RuleProposal {
  /** Number of feedback entries in the supporting cluster. */
  clusterSize: number
  /** Inferred target file for the proposed rule. */
  targetFile: string | null
  /** Synthesized rule text (from LLM or template). */
  proposedRule: string
  /** IDs of feedback entries supporting this proposal. */
  supportingFeedbackIds: string[]
  /** Confidence score: average cluster similarity + size bonus, capped at 0.99. */
  confidence: number
}

// ──────────────────────────────────────────────────
// Pipeline configuration
// ──────────────────────────────────────────────────

export interface CorrectionStrengthenerConfig {
  /** Cosine similarity threshold for clustering. Default: 0.82. */
  similarityThreshold?: number
  /** Minimum cluster size to generate a proposal. Default: 3. */
  minClusterSize?: number
}

// ──────────────────────────────────────────────────
// Pipeline dependencies (injected for testability)
// ──────────────────────────────────────────────────

export type EmbeddingFn = (text: string) => Promise<number[]>

export type RuleSynthesizer = (feedbackEntries: FeedbackEntry[]) => Promise<string>

// ──────────────────────────────────────────────────
// Pipeline result
// ──────────────────────────────────────────────────

export interface StrengtheningResult {
  proposals: RuleProposal[]
  totalFeedback: number
  clustersFound: number
  clustersAboveThreshold: number
}
