import { buildClusters, clusterConfidence } from "./clustering.js"
import type {
  CorrectionStrengthenerConfig,
  EmbeddingFn,
  FeedbackEntry,
  RuleProposal,
  RuleSynthesizer,
  StrengtheningResult,
} from "./types.js"

// ──────────────────────────────────────────────────
// Target file inference
// ──────────────────────────────────────────────────

/**
 * Infer the most likely target file from a cluster of feedback entries.
 * Uses majority vote over entries that have a targetFile set.
 */
export function inferTargetFile(entries: FeedbackEntry[]): string | null {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.targetFile) {
      counts.set(entry.targetFile, (counts.get(entry.targetFile) ?? 0) + 1)
    }
  }

  if (counts.size === 0) return null

  let best: string | null = null
  let bestCount = 0
  for (const [file, count] of counts) {
    if (count > bestCount) {
      best = file
      bestCount = count
    }
  }
  return best
}

// ──────────────────────────────────────────────────
// Proposal builder
// ──────────────────────────────────────────────────

const DEFAULT_SIMILARITY_THRESHOLD = 0.82
const DEFAULT_MIN_CLUSTER_SIZE = 3

/**
 * Build rule proposals from feedback entries and their embeddings.
 *
 * Pipeline:
 * 1. Cluster embeddings by cosine similarity (union-find)
 * 2. Filter clusters by minimum size
 * 3. For each qualifying cluster, synthesize a rule and compute confidence
 * 4. Sort by (cluster_size, confidence) descending
 */
export async function buildProposals(
  entries: FeedbackEntry[],
  embeddings: number[][],
  synthesize: RuleSynthesizer,
  config: CorrectionStrengthenerConfig = {},
): Promise<RuleProposal[]> {
  const threshold = config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const minSize = config.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE

  const clusters = buildClusters(embeddings, threshold, minSize)
  const proposals: RuleProposal[] = []

  for (const cluster of clusters) {
    const clusterEntries = cluster.indices.map((i) => entries[i]!)
    const proposedRule = await synthesize(clusterEntries)

    proposals.push({
      clusterSize: cluster.indices.length,
      targetFile: inferTargetFile(clusterEntries),
      proposedRule,
      supportingFeedbackIds: clusterEntries.map((e) => e.id),
      confidence: clusterConfidence(embeddings, cluster.indices),
    })
  }

  return proposals.sort((a, b) => b.clusterSize - a.clusterSize || b.confidence - a.confidence)
}

// ──────────────────────────────────────────────────
// Full pipeline
// ──────────────────────────────────────────────────

export interface CorrectionStrengthenerDeps {
  embed: EmbeddingFn
  synthesize: RuleSynthesizer
}

/**
 * Run the full correction strengthening pipeline.
 *
 * 1. Embed all feedback entries
 * 2. Cluster by similarity
 * 3. Build proposals for qualifying clusters
 */
export async function runCorrectionStrengthener(
  entries: FeedbackEntry[],
  deps: CorrectionStrengthenerDeps,
  config: CorrectionStrengthenerConfig = {},
): Promise<StrengtheningResult> {
  const threshold = config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const minSize = config.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE

  // 1. Embed all entries
  const embeddings: number[][] = []
  for (const entry of entries) {
    embeddings.push(await deps.embed(entry.content))
  }

  // 2. Cluster
  const clusters = buildClusters(embeddings, threshold, minSize)

  // 3. Build proposals
  const proposals = await buildProposals(entries, embeddings, deps.synthesize, config)

  return {
    proposals,
    totalFeedback: entries.length,
    clustersFound: buildClusters(embeddings, threshold, 1).length,
    clustersAboveThreshold: clusters.length,
  }
}
