import { cosineSimilarity } from "../memory/dedup.js"
import type { FeedbackCluster } from "./types.js"

// ──────────────────────────────────────────────────
// Union-Find clustering
// ──────────────────────────────────────────────────

/**
 * Cluster embedding indices by cosine similarity using union-find.
 *
 * For each pair of embeddings with similarity >= threshold,
 * the indices are unioned. Returns clusters sorted by size (largest first).
 */
export function clusterIndices(embeddings: number[][], threshold: number): number[][] {
  const n = embeddings.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const rank = new Array<number>(n).fill(0)

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]! // path compression
      x = parent[x]!
    }
    return x
  }

  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    // union by rank
    if (rank[ra]! < rank[rb]!) {
      parent[ra] = rb
    } else if (rank[ra]! > rank[rb]!) {
      parent[rb] = ra
    } else {
      parent[rb] = ra
      rank[ra]!++
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(embeddings[i]!, embeddings[j]!) >= threshold) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const group = groups.get(root)
    if (group) {
      group.push(i)
    } else {
      groups.set(root, [i])
    }
  }

  return [...groups.values()].sort((a, b) => b.length - a.length)
}

// ──────────────────────────────────────────────────
// Cluster confidence scoring
// ──────────────────────────────────────────────────

/**
 * Compute confidence score for a cluster.
 *
 * Confidence = average pairwise cosine similarity + size bonus (capped at 0.99).
 * Size bonus: 0.03 per member, max 0.2.
 */
export function clusterConfidence(embeddings: number[][], indices: number[]): number {
  if (indices.length <= 1) return 0

  let total = 0
  let count = 0
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      total += cosineSimilarity(embeddings[indices[i]!]!, embeddings[indices[j]!]!)
      count++
    }
  }

  const avg = count > 0 ? total / count : 0
  const sizeBonus = Math.min(0.2, 0.03 * indices.length)
  return Math.round(Math.min(0.99, avg + sizeBonus) * 1000) / 1000
}

/**
 * Build FeedbackCluster objects from embeddings with similarity and size filtering.
 */
export function buildClusters(
  embeddings: number[][],
  similarityThreshold: number,
  minClusterSize: number,
): FeedbackCluster[] {
  const indexGroups = clusterIndices(embeddings, similarityThreshold)

  return indexGroups
    .filter((indices) => indices.length >= minClusterSize)
    .map((indices) => ({
      indices,
      avgSimilarity: clusterConfidence(embeddings, indices),
    }))
}
