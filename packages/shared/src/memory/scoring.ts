import type { MemoryRecord, MemoryType, ScoredMemoryRecord } from "./types.js"

const MS_PER_DAY = 86_400_000

const HALF_LIFE_DAYS: Record<MemoryType, number> = {
  fact: 365,
  preference: 180,
  event: 14,
  system_rule: Infinity,
}

const WEIGHTS = {
  similarity: 0.5,
  recency: 0.3,
  utility: 0.2,
} as const

export function calculateDecay(
  createdAt: number,
  type: MemoryType,
  now: number = Date.now(),
): number {
  const halfLife = HALF_LIFE_DAYS[type]
  if (!Number.isFinite(halfLife)) return 1.0

  const ageDays = (now - createdAt) / MS_PER_DAY
  if (ageDays <= 0) return 1.0

  return Math.pow(0.5, ageDays / halfLife)
}

const MAX_UTILITY_NORM = 3.0

export function calculateUtility(accessCount: number): number {
  return Math.min(Math.log10(accessCount + 1) / MAX_UTILITY_NORM, 1.0)
}

export function scoreMemory(
  record: MemoryRecord,
  similarity: number,
  now: number = Date.now(),
): number {
  const recency = calculateDecay(record.createdAt, record.type, now)
  const utility = calculateUtility(record.accessCount)

  return WEIGHTS.similarity * similarity + WEIGHTS.recency * recency + WEIGHTS.utility * utility
}

export function rankMemories(
  records: Array<{ record: MemoryRecord; similarity: number }>,
  now: number = Date.now(),
): ScoredMemoryRecord[] {
  return records
    .map(({ record, similarity }) => ({
      ...record,
      similarity,
      score: scoreMemory(record, similarity, now),
    }))
    .sort((a, b) => b.score - a.score)
}
