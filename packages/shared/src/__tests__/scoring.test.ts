import { describe, expect, it } from "vitest"

import { calculateDecay, calculateUtility, rankMemories, scoreMemory } from "../memory/scoring.js"
import type { MemoryRecord } from "../memory/types.js"

const MS_PER_DAY = 86_400_000

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "test-id",
    type: "fact",
    content: "Test memory",
    tags: [],
    people: [],
    projects: [],
    importance: 3,
    confidence: 0.9,
    source: "test",
    createdAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

describe("calculateDecay", () => {
  const now = 1_700_000_000_000

  it("returns 1.0 for a memory just created", () => {
    expect(calculateDecay(now, "fact", now)).toBe(1.0)
  })

  it("returns 1.0 for a memory created in the future", () => {
    expect(calculateDecay(now + MS_PER_DAY, "fact", now)).toBe(1.0)
  })

  it("returns 0.5 for a fact at exactly 365 days old", () => {
    const createdAt = now - 365 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "fact", now)
    expect(decay).toBeCloseTo(0.5, 5)
  })

  it("returns 0.5 for a preference at exactly 180 days old", () => {
    const createdAt = now - 180 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "preference", now)
    expect(decay).toBeCloseTo(0.5, 5)
  })

  it("returns 0.5 for an event at exactly 14 days old", () => {
    const createdAt = now - 14 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "event", now)
    expect(decay).toBeCloseTo(0.5, 5)
  })

  it("returns 1.0 for system_rule regardless of age", () => {
    const createdAt = now - 10_000 * MS_PER_DAY
    expect(calculateDecay(createdAt, "system_rule", now)).toBe(1.0)
  })

  it("returns 0.25 at two half-lives", () => {
    const createdAt = now - 2 * 365 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "fact", now)
    expect(decay).toBeCloseTo(0.25, 5)
  })

  it("returns 0.125 at three half-lives", () => {
    const createdAt = now - 3 * 365 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "fact", now)
    expect(decay).toBeCloseTo(0.125, 5)
  })

  it("approaches 0 for very old memories", () => {
    const createdAt = now - 10 * 365 * MS_PER_DAY
    const decay = calculateDecay(createdAt, "fact", now)
    expect(decay).toBeLessThan(0.001)
    expect(decay).toBeGreaterThan(0)
  })
})

describe("calculateUtility", () => {
  it("returns 0 for accessCount 0", () => {
    expect(calculateUtility(0)).toBe(0)
  })

  it("returns normalized log10(2)/3 for accessCount 1", () => {
    expect(calculateUtility(1)).toBeCloseTo(Math.log10(2) / 3, 5)
  })

  it("returns normalized log10(11)/3 for accessCount 10", () => {
    expect(calculateUtility(10)).toBeCloseTo(Math.log10(11) / 3, 5)
  })

  it("is capped at 1.0", () => {
    // log10(1001) / 3 ≈ 1.0, so higher counts should still cap at 1.0
    expect(calculateUtility(10000)).toBeLessThanOrEqual(1.0)
  })

  it("increases monotonically with access count", () => {
    const util0 = calculateUtility(0)
    const util10 = calculateUtility(10)
    const util100 = calculateUtility(100)
    const util1000 = calculateUtility(1000)

    expect(util10).toBeGreaterThan(util0)
    expect(util100).toBeGreaterThan(util10)
    expect(util1000).toBeGreaterThan(util100)
  })
})

describe("scoreMemory", () => {
  const now = 1_700_000_000_000

  it("produces higher score for higher similarity", () => {
    const record = makeRecord({ createdAt: now, accessCount: 0 })
    const low = scoreMemory(record, 0.3, now)
    const high = scoreMemory(record, 0.9, now)
    expect(high).toBeGreaterThan(low)
  })

  it("produces higher score for more recent memories", () => {
    const recent = makeRecord({ createdAt: now - 1 * MS_PER_DAY, type: "event" })
    const old = makeRecord({ createdAt: now - 30 * MS_PER_DAY, type: "event" })

    const recentScore = scoreMemory(recent, 0.7, now)
    const oldScore = scoreMemory(old, 0.7, now)
    expect(recentScore).toBeGreaterThan(oldScore)
  })

  it("produces higher score for frequently accessed memories", () => {
    const lowAccess = makeRecord({ createdAt: now, accessCount: 0 })
    const highAccess = makeRecord({ createdAt: now, accessCount: 100 })

    const lowScore = scoreMemory(lowAccess, 0.7, now)
    const highScore = scoreMemory(highAccess, 0.7, now)
    expect(highScore).toBeGreaterThan(lowScore)
  })

  it("similarity dominates over recency and utility", () => {
    // High similarity, old, never accessed
    const highSim = makeRecord({
      createdAt: now - 300 * MS_PER_DAY,
      accessCount: 0,
      type: "fact",
    })
    // Low similarity, brand new, heavily accessed
    const lowSim = makeRecord({
      createdAt: now,
      accessCount: 50,
      type: "fact",
    })

    const highSimScore = scoreMemory(highSim, 0.95, now)
    const lowSimScore = scoreMemory(lowSim, 0.2, now)
    expect(highSimScore).toBeGreaterThan(lowSimScore)
  })

  it("system_rule memories never decay", () => {
    const oldRule = makeRecord({
      type: "system_rule",
      createdAt: now - 3650 * MS_PER_DAY,
      accessCount: 0,
    })
    const newRule = makeRecord({
      type: "system_rule",
      createdAt: now,
      accessCount: 0,
    })

    const oldScore = scoreMemory(oldRule, 0.8, now)
    const newScore = scoreMemory(newRule, 0.8, now)
    expect(oldScore).toBe(newScore)
  })
})

describe("rankMemories", () => {
  const now = 1_700_000_000_000

  it("returns memories sorted by score descending", () => {
    const records = [
      { record: makeRecord({ createdAt: now, accessCount: 0 }), similarity: 0.3 },
      { record: makeRecord({ createdAt: now, accessCount: 0 }), similarity: 0.9 },
      { record: makeRecord({ createdAt: now, accessCount: 0 }), similarity: 0.6 },
    ]

    const ranked = rankMemories(records, now)
    expect(ranked[0]!.similarity).toBe(0.9)
    expect(ranked[1]!.similarity).toBe(0.6)
    expect(ranked[2]!.similarity).toBe(0.3)
  })

  it("includes score and similarity on each result", () => {
    const records = [{ record: makeRecord({ createdAt: now }), similarity: 0.8 }]

    const ranked = rankMemories(records, now)
    expect(ranked[0]).toHaveProperty("score")
    expect(ranked[0]).toHaveProperty("similarity")
    expect(ranked[0]!.score).toBeGreaterThan(0)
  })

  it("returns empty array for empty input", () => {
    expect(rankMemories([], now)).toEqual([])
  })
})
