import { describe, expect, it } from "vitest"

import { AtomicFactSchema, ExtractionResponseSchema, SourceSchema } from "../memory/schemas.js"

// ──────────────────────────────────────────────────
// Helper factory
// ──────────────────────────────────────────────────

function validFact(overrides: Record<string, unknown> = {}) {
  return {
    content: "The API uses REST with JSON payloads for all endpoints",
    type: "fact",
    confidence: 0.9,
    importance: 3,
    tags: ["api", "rest"],
    people: [],
    projects: ["cortex"],
    source: {
      sessionId: "sess-001",
      turnIndex: 5,
      timestamp: "2025-01-15T10:30:00Z",
    },
    ...overrides,
  }
}

// ──────────────────────────────────────────────────
// SourceSchema
// ──────────────────────────────────────────────────

describe("SourceSchema", () => {
  it("accepts a valid source", () => {
    const source = { sessionId: "sess-001", turnIndex: 5, timestamp: "2025-01-15T10:30:00Z" }
    expect(SourceSchema.parse(source)).toEqual(source)
  })

  it("rejects non-integer turnIndex", () => {
    expect(() =>
      SourceSchema.parse({
        sessionId: "sess-001",
        turnIndex: 5.5,
        timestamp: "2025-01-15T10:30:00Z",
      }),
    ).toThrow()
  })

  it("rejects missing sessionId", () => {
    expect(() => SourceSchema.parse({ turnIndex: 5, timestamp: "2025-01-15T10:30:00Z" })).toThrow()
  })
})

// ──────────────────────────────────────────────────
// AtomicFactSchema
// ──────────────────────────────────────────────────

describe("AtomicFactSchema", () => {
  it("accepts a valid fact", () => {
    const fact = validFact()
    const result = AtomicFactSchema.parse(fact)
    expect(result.content).toBe(fact.content)
    expect(result.type).toBe("fact")
  })

  it("accepts all valid types", () => {
    for (const type of ["fact", "preference", "event", "system_rule", "lesson", "relationship"]) {
      const result = AtomicFactSchema.parse(validFact({ type }))
      expect(result.type).toBe(type)
    }
  })

  it("rejects content shorter than 10 characters", () => {
    expect(() => AtomicFactSchema.parse(validFact({ content: "too short" }))).toThrow()
  })

  it("rejects content longer than 2000 characters", () => {
    expect(() => AtomicFactSchema.parse(validFact({ content: "x".repeat(2001) }))).toThrow()
  })

  it("accepts content at min boundary (10 chars)", () => {
    const result = AtomicFactSchema.parse(validFact({ content: "a".repeat(10) }))
    expect(result.content).toHaveLength(10)
  })

  it("accepts content at max boundary (2000 chars)", () => {
    const result = AtomicFactSchema.parse(validFact({ content: "a".repeat(2000) }))
    expect(result.content).toHaveLength(2000)
  })

  it("rejects invalid type", () => {
    expect(() => AtomicFactSchema.parse(validFact({ type: "invalid" }))).toThrow()
  })

  it("rejects confidence below 0", () => {
    expect(() => AtomicFactSchema.parse(validFact({ confidence: -0.1 }))).toThrow()
  })

  it("rejects confidence above 1", () => {
    expect(() => AtomicFactSchema.parse(validFact({ confidence: 1.1 }))).toThrow()
  })

  it("accepts confidence at boundaries", () => {
    expect(AtomicFactSchema.parse(validFact({ confidence: 0 })).confidence).toBe(0)
    expect(AtomicFactSchema.parse(validFact({ confidence: 1 })).confidence).toBe(1)
  })

  it("rejects importance below 1", () => {
    expect(() => AtomicFactSchema.parse(validFact({ importance: 0 }))).toThrow()
  })

  it("rejects importance above 5", () => {
    expect(() => AtomicFactSchema.parse(validFact({ importance: 6 }))).toThrow()
  })

  it("rejects non-integer importance", () => {
    expect(() => AtomicFactSchema.parse(validFact({ importance: 2.5 }))).toThrow()
  })

  it("rejects more than 10 tags", () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`)
    expect(() => AtomicFactSchema.parse(validFact({ tags }))).toThrow()
  })

  it("accepts up to 10 tags", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`)
    const result = AtomicFactSchema.parse(validFact({ tags }))
    expect(result.tags).toHaveLength(10)
  })

  it("rejects more than 10 people", () => {
    const people = Array.from({ length: 11 }, (_, i) => `person-${i}`)
    expect(() => AtomicFactSchema.parse(validFact({ people }))).toThrow()
  })

  it("rejects more than 10 projects", () => {
    const projects = Array.from({ length: 11 }, (_, i) => `project-${i}`)
    expect(() => AtomicFactSchema.parse(validFact({ projects }))).toThrow()
  })

  it("accepts optional supersedes array", () => {
    const result = AtomicFactSchema.parse(validFact({ supersedes: ["id-1", "id-2"] }))
    expect(result.supersedes).toEqual(["id-1", "id-2"])
  })

  it("accepts fact without supersedes", () => {
    const fact = validFact()
    delete (fact as Record<string, unknown>)["supersedes"]
    const result = AtomicFactSchema.parse(fact)
    expect(result.supersedes).toBeUndefined()
  })

  it("rejects missing required fields", () => {
    expect(() => AtomicFactSchema.parse({})).toThrow()
    expect(() => AtomicFactSchema.parse({ content: "long enough content" })).toThrow()
  })
})

// ──────────────────────────────────────────────────
// ExtractionResponseSchema
// ──────────────────────────────────────────────────

describe("ExtractionResponseSchema", () => {
  it("accepts a valid response with facts", () => {
    const response = { facts: [validFact(), validFact({ type: "preference" })] }
    const result = ExtractionResponseSchema.parse(response)
    expect(result.facts).toHaveLength(2)
  })

  it("accepts an empty facts array", () => {
    const result = ExtractionResponseSchema.parse({ facts: [] })
    expect(result.facts).toHaveLength(0)
  })

  it("rejects missing facts key", () => {
    expect(() => ExtractionResponseSchema.parse({})).toThrow()
  })

  it("rejects facts containing invalid items", () => {
    expect(() => ExtractionResponseSchema.parse({ facts: [{ content: "too short" }] })).toThrow()
  })
})
