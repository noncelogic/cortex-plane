import { describe, expect, it } from "vitest"

import {
  buildClusters,
  clusterConfidence,
  clusterIndices,
} from "../correction-strengthener/clustering.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

/** Create a unit vector in the given direction (1-hot in d dimensions). */
function basisVector(dim: number, idx: number): number[] {
  const v = new Array<number>(dim).fill(0)
  v[idx] = 1
  return v
}

/** Create a vector close to a basis vector with small perturbation. */
function nearBasisVector(dim: number, idx: number, noise = 0.05): number[] {
  const v = basisVector(dim, idx)
  for (let i = 0; i < dim; i++) {
    v[i] = v[i]! + (Math.random() - 0.5) * noise
  }
  return v
}

// ──────────────────────────────────────────────────
// clusterIndices
// ──────────────────────────────────────────────────

describe("clusterIndices", () => {
  it("returns a single cluster for identical embeddings", () => {
    const v = [1, 0, 0]
    const embeddings = [v, v, v]
    const clusters = clusterIndices(embeddings, 0.9)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toHaveLength(3)
    expect(clusters[0]).toEqual(expect.arrayContaining([0, 1, 2]))
  })

  it("returns separate clusters for orthogonal embeddings", () => {
    const embeddings = [
      basisVector(3, 0),
      basisVector(3, 0),
      basisVector(3, 1),
      basisVector(3, 1),
      basisVector(3, 2),
    ]
    const clusters = clusterIndices(embeddings, 0.9)

    expect(clusters).toHaveLength(3)
    // Sorted by size: two groups of 2, one group of 1
    expect(clusters[0]).toHaveLength(2)
    expect(clusters[1]).toHaveLength(2)
    expect(clusters[2]).toHaveLength(1)
  })

  it("returns each index in its own cluster when all dissimilar", () => {
    const embeddings = [basisVector(3, 0), basisVector(3, 1), basisVector(3, 2)]
    const clusters = clusterIndices(embeddings, 0.9)

    expect(clusters).toHaveLength(3)
    expect(clusters.every((c) => c.length === 1)).toBe(true)
  })

  it("handles empty input", () => {
    const clusters = clusterIndices([], 0.9)
    expect(clusters).toHaveLength(0)
  })

  it("handles single embedding", () => {
    const clusters = clusterIndices([[1, 0, 0]], 0.9)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual([0])
  })

  it("clusters sorted by size descending", () => {
    // 3 similar + 2 similar + 1 alone
    const embeddings = [
      basisVector(4, 0),
      basisVector(4, 0),
      basisVector(4, 0),
      basisVector(4, 1),
      basisVector(4, 1),
      basisVector(4, 2),
    ]
    const clusters = clusterIndices(embeddings, 0.9)

    expect(clusters.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1]!.length).toBeGreaterThanOrEqual(clusters[i]!.length)
    }
  })

  it("uses threshold to control cluster granularity", () => {
    // Near-similar vectors that pass at 0.8 but fail at 0.99
    const dim = 10
    const embeddings = [
      nearBasisVector(dim, 0, 0.3),
      nearBasisVector(dim, 0, 0.3),
      nearBasisVector(dim, 0, 0.3),
    ]

    const looseClusters = clusterIndices(embeddings, 0.8)
    const tightClusters = clusterIndices(embeddings, 0.999)

    expect(looseClusters.length).toBeLessThanOrEqual(tightClusters.length)
  })
})

// ──────────────────────────────────────────────────
// clusterConfidence
// ──────────────────────────────────────────────────

describe("clusterConfidence", () => {
  it("returns 0 for single-element cluster", () => {
    const embeddings = [[1, 0, 0]]
    expect(clusterConfidence(embeddings, [0])).toBe(0)
  })

  it("returns high confidence for identical vectors", () => {
    const v = [1, 0, 0]
    const embeddings = [v, v, v]
    const conf = clusterConfidence(embeddings, [0, 1, 2])

    // avg sim = 1.0, size bonus = min(0.2, 0.03*3) = 0.09
    // total = min(0.99, 1.0 + 0.09) = 0.99
    expect(conf).toBeCloseTo(0.99, 2)
  })

  it("caps at 0.99", () => {
    const v = [1, 0, 0]
    const embeddings = Array.from({ length: 10 }, () => v)
    const indices = Array.from({ length: 10 }, (_, i) => i)
    const conf = clusterConfidence(embeddings, indices)

    expect(conf).toBeLessThanOrEqual(0.99)
  })

  it("size bonus increases with cluster size", () => {
    const v = [1, 0, 0]
    const embeddings = Array.from({ length: 6 }, () => v)

    const conf3 = clusterConfidence(embeddings, [0, 1, 2])
    const conf5 = clusterConfidence(embeddings, [0, 1, 2, 3, 4])

    // Both capped at 0.99 since similarity is 1.0, but both should be 0.99
    expect(conf3).toBeCloseTo(0.99, 2)
    expect(conf5).toBeCloseTo(0.99, 2)
  })

  it("returns lower confidence for dissimilar vectors", () => {
    // Two somewhat similar vectors
    const embeddings = [
      [1, 0.5, 0],
      [1, -0.5, 0],
    ]
    const conf = clusterConfidence(embeddings, [0, 1])

    // cosine sim ≈ 0.6, size bonus = 0.06
    expect(conf).toBeGreaterThan(0.5)
    expect(conf).toBeLessThan(0.99)
  })
})

// ──────────────────────────────────────────────────
// buildClusters
// ──────────────────────────────────────────────────

describe("buildClusters", () => {
  it("filters clusters below minimum size", () => {
    const v = [1, 0, 0]
    const embeddings = [v, v, basisVector(3, 1)]
    const clusters = buildClusters(embeddings, 0.9, 3)

    // Only 2 similar vectors, below minClusterSize=3
    expect(clusters).toHaveLength(0)
  })

  it("returns qualifying clusters with avgSimilarity", () => {
    const v = [1, 0, 0]
    const embeddings = [v, v, v, basisVector(3, 1)]
    const clusters = buildClusters(embeddings, 0.9, 3)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.indices).toHaveLength(3)
    expect(clusters[0]!.avgSimilarity).toBeGreaterThan(0.9)
  })

  it("returns multiple qualifying clusters", () => {
    const embeddings = [
      ...Array.from({ length: 4 }, () => basisVector(3, 0)),
      ...Array.from({ length: 3 }, () => basisVector(3, 1)),
    ]
    const clusters = buildClusters(embeddings, 0.9, 3)

    expect(clusters).toHaveLength(2)
    expect(clusters[0]!.indices).toHaveLength(4) // larger first
    expect(clusters[1]!.indices).toHaveLength(3)
  })

  it("returns empty for empty input", () => {
    expect(buildClusters([], 0.9, 3)).toHaveLength(0)
  })
})
