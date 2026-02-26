import type { AtomicFact } from "./schemas.js"
import type { MemoryRecord } from "./types.js"

// ──────────────────────────────────────────────────
// Cosine similarity
// ──────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    normA += ai * ai
    normB += bi * bi
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0

  return dot / denom
}

// ──────────────────────────────────────────────────
// Duplicate detection
// ──────────────────────────────────────────────────

const DEFAULT_DUPLICATE_THRESHOLD = 0.92

export function isDuplicate(similarity: number, threshold = DEFAULT_DUPLICATE_THRESHOLD): boolean {
  return similarity >= threshold
}

// ──────────────────────────────────────────────────
// Supersession detection
// ──────────────────────────────────────────────────

/**
 * Determine if a candidate fact should supersede an existing record.
 * Conditions: newer timestamp AND higher or equal confidence.
 */
export function shouldSupersede(existing: MemoryRecord, candidate: AtomicFact): boolean {
  const candidateTs = new Date(candidate.source.timestamp).getTime()
  const existingTs = existing.createdAt

  if (candidateTs <= existingTs) return false
  return candidate.confidence >= existing.confidence
}

// ──────────────────────────────────────────────────
// Metadata merging
// ──────────────────────────────────────────────────

/**
 * Merge tags, people, and projects from existing + candidate,
 * deduplicating and respecting the 10-item limit.
 */
export function mergeMetadata(
  existing: MemoryRecord,
  candidate: AtomicFact,
): { tags: string[]; people: string[]; projects: string[] } {
  return {
    tags: uniqueSlice([...existing.tags, ...candidate.tags], 10),
    people: uniqueSlice([...existing.people, ...candidate.people], 10),
    projects: uniqueSlice([...existing.projects, ...candidate.projects], 10),
  }
}

function uniqueSlice(arr: string[], max: number): string[] {
  return [...new Set(arr)].slice(0, max)
}
