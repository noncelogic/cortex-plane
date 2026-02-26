import { describe, expect, it } from "vitest"

import { cosineSimilarity, isDuplicate, mergeMetadata, shouldSupersede } from "../memory/dedup.js"
import type { AtomicFact } from "../memory/schemas.js"
import type { MemoryRecord } from "../memory/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "existing-1",
    type: "fact",
    content: "Existing memory content for testing",
    tags: ["tag-a"],
    people: ["alice"],
    projects: ["project-x"],
    importance: 3,
    confidence: 0.8,
    source: "session:sess-001:5",
    createdAt: new Date("2025-01-10T10:00:00Z").getTime(),
    accessCount: 2,
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

function makeFact(overrides: Partial<AtomicFact> = {}): AtomicFact {
  return {
    content: "Updated memory content for testing purposes",
    type: "fact",
    confidence: 0.9,
    importance: 4,
    tags: ["tag-b"],
    people: ["bob"],
    projects: ["project-y"],
    source: {
      sessionId: "sess-002",
      turnIndex: 3,
      timestamp: "2025-01-15T10:00:00Z",
    },
    ...overrides,
  }
}

// ──────────────────────────────────────────────────
// cosineSimilarity
// ──────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it("returns -1.0 for opposite vectors", () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10)
  })

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0)
  })

  it("handles high-dimensional vectors", () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i))
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 0.1))
    const sim = cosineSimilarity(a, b)
    expect(sim).toBeGreaterThan(0.9)
    expect(sim).toBeLessThanOrEqual(1.0)
  })

  it("is commutative", () => {
    const a = [1, 2, 3]
    const b = [4, 5, 6]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10)
  })

  it("is scale-invariant", () => {
    const a = [1, 2, 3]
    const b = [2, 4, 6]
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10)
  })
})

// ──────────────────────────────────────────────────
// isDuplicate
// ──────────────────────────────────────────────────

describe("isDuplicate", () => {
  it("returns true when similarity equals threshold", () => {
    expect(isDuplicate(0.92)).toBe(true)
  })

  it("returns true when similarity exceeds threshold", () => {
    expect(isDuplicate(0.99)).toBe(true)
  })

  it("returns false when similarity is below threshold", () => {
    expect(isDuplicate(0.91)).toBe(false)
  })

  it("uses custom threshold", () => {
    expect(isDuplicate(0.85, 0.85)).toBe(true)
    expect(isDuplicate(0.84, 0.85)).toBe(false)
  })

  it("threshold of 1.0 only matches perfect similarity", () => {
    expect(isDuplicate(0.999, 1.0)).toBe(false)
    expect(isDuplicate(1.0, 1.0)).toBe(true)
  })
})

// ──────────────────────────────────────────────────
// shouldSupersede
// ──────────────────────────────────────────────────

describe("shouldSupersede", () => {
  it("returns true when candidate is newer with higher confidence", () => {
    const existing = makeRecord({ confidence: 0.7, createdAt: new Date("2025-01-10").getTime() })
    const candidate = makeFact({
      confidence: 0.9,
      source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-15T00:00:00Z" },
    })
    expect(shouldSupersede(existing, candidate)).toBe(true)
  })

  it("returns true when candidate is newer with equal confidence", () => {
    const existing = makeRecord({ confidence: 0.8, createdAt: new Date("2025-01-10").getTime() })
    const candidate = makeFact({
      confidence: 0.8,
      source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-15T00:00:00Z" },
    })
    expect(shouldSupersede(existing, candidate)).toBe(true)
  })

  it("returns false when candidate is newer but lower confidence", () => {
    const existing = makeRecord({ confidence: 0.9, createdAt: new Date("2025-01-10").getTime() })
    const candidate = makeFact({
      confidence: 0.5,
      source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-15T00:00:00Z" },
    })
    expect(shouldSupersede(existing, candidate)).toBe(false)
  })

  it("returns false when candidate is older", () => {
    const existing = makeRecord({ confidence: 0.7, createdAt: new Date("2025-01-15").getTime() })
    const candidate = makeFact({
      confidence: 0.9,
      source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-10T00:00:00Z" },
    })
    expect(shouldSupersede(existing, candidate)).toBe(false)
  })

  it("returns false when candidate has same timestamp", () => {
    const ts = new Date("2025-01-15").getTime()
    const existing = makeRecord({ confidence: 0.7, createdAt: ts })
    const candidate = makeFact({
      confidence: 0.9,
      source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-15T00:00:00Z" },
    })
    expect(shouldSupersede(existing, candidate)).toBe(false)
  })
})

// ──────────────────────────────────────────────────
// mergeMetadata
// ──────────────────────────────────────────────────

describe("mergeMetadata", () => {
  it("merges tags, people, and projects without duplicates", () => {
    const existing = makeRecord({ tags: ["a", "b"], people: ["alice"], projects: ["x"] })
    const candidate = makeFact({ tags: ["b", "c"], people: ["alice", "bob"], projects: ["x", "y"] })

    const merged = mergeMetadata(existing, candidate)

    expect(merged.tags).toEqual(["a", "b", "c"])
    expect(merged.people).toEqual(["alice", "bob"])
    expect(merged.projects).toEqual(["x", "y"])
  })

  it("limits to 10 items per field", () => {
    const existingTags = Array.from({ length: 8 }, (_, i) => `existing-${i}`)
    const candidateTags = Array.from({ length: 8 }, (_, i) => `candidate-${i}`)

    const existing = makeRecord({ tags: existingTags })
    const candidate = makeFact({ tags: candidateTags })

    const merged = mergeMetadata(existing, candidate)
    expect(merged.tags).toHaveLength(10)
  })

  it("preserves order with existing first", () => {
    const existing = makeRecord({ tags: ["first"], people: [], projects: [] })
    const candidate = makeFact({ tags: ["second"], people: [], projects: [] })

    const merged = mergeMetadata(existing, candidate)
    expect(merged.tags[0]).toBe("first")
    expect(merged.tags[1]).toBe("second")
  })

  it("handles empty arrays", () => {
    const existing = makeRecord({ tags: [], people: [], projects: [] })
    const candidate = makeFact({ tags: [], people: [], projects: [] })

    const merged = mergeMetadata(existing, candidate)
    expect(merged.tags).toEqual([])
    expect(merged.people).toEqual([])
    expect(merged.projects).toEqual([])
  })
})
