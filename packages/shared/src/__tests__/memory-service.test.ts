import { describe, expect, it, vi } from "vitest"

import type { AtomicFact } from "../memory/schemas.js"
import { factToRecord, MemoryService } from "../memory/service.js"
import type { MemoryRecord, ScoredMemoryRecord } from "../memory/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeFact(overrides: Partial<AtomicFact> = {}): AtomicFact {
  return {
    content: "The payment service requires PostgreSQL 15 or higher",
    type: "fact",
    confidence: 0.9,
    importance: 4,
    tags: ["infrastructure"],
    people: [],
    projects: ["payment-service"],
    source: {
      sessionId: "sess-001",
      turnIndex: 3,
      timestamp: "2025-01-15T10:30:00Z",
    },
    ...overrides,
  }
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "rec-001",
    type: "fact",
    content: "The payment service requires PostgreSQL 14",
    tags: ["infrastructure"],
    people: [],
    projects: ["payment-service"],
    importance: 3,
    confidence: 0.8,
    source: "session:sess-000:2",
    createdAt: new Date("2025-01-10T10:00:00Z").getTime(),
    accessCount: 1,
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

function makeScoredRecord(
  overrides: Partial<MemoryRecord> = {},
  similarity = 0.5,
): ScoredMemoryRecord {
  return {
    ...makeRecord(overrides),
    score: 0.7,
    similarity,
  }
}

function mockStore(
  searchResults: ScoredMemoryRecord[] = [],
  getByIdResult: MemoryRecord | null = null,
) {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(searchResults),
    getById: vi.fn().mockResolvedValue(getByIdResult),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

const fakeEmbedding = Array.from({ length: 1536 }, () => 0.01)

// ──────────────────────────────────────────────────
// factToRecord
// ──────────────────────────────────────────────────

describe("factToRecord", () => {
  it("converts an AtomicFact to a MemoryRecord", () => {
    const fact = makeFact()
    const record = factToRecord(fact)

    expect(record.content).toBe(fact.content)
    expect(record.type).toBe("fact")
    expect(record.tags).toEqual(fact.tags)
    expect(record.people).toEqual(fact.people)
    expect(record.projects).toEqual(fact.projects)
    expect(record.importance).toBe(fact.importance)
    expect(record.confidence).toBe(fact.confidence)
    expect(record.source).toBe("session:sess-001:3")
    expect(record.accessCount).toBe(0)
    expect(record.id).toBeTruthy()
  })

  it("uses provided ID", () => {
    const record = factToRecord(makeFact(), "custom-id")
    expect(record.id).toBe("custom-id")
  })

  it("maps lesson type to fact", () => {
    const record = factToRecord(makeFact({ type: "lesson" }))
    expect(record.type).toBe("fact")
  })

  it("maps relationship type to fact", () => {
    const record = factToRecord(makeFact({ type: "relationship" }))
    expect(record.type).toBe("fact")
  })

  it("preserves native MemoryType values", () => {
    for (const type of ["fact", "preference", "event", "system_rule"] as const) {
      const record = factToRecord(makeFact({ type }))
      expect(record.type).toBe(type)
    }
  })

  it("parses timestamp into createdAt", () => {
    const record = factToRecord(
      makeFact({ source: { sessionId: "s", turnIndex: 0, timestamp: "2025-06-15T12:00:00Z" } }),
    )
    expect(record.createdAt).toBe(new Date("2025-06-15T12:00:00Z").getTime())
  })
})

// ──────────────────────────────────────────────────
// MemoryService.store
// ──────────────────────────────────────────────────

describe("MemoryService.store", () => {
  it("inserts a novel fact when no duplicates found", async () => {
    const store = mockStore([])
    const service = new MemoryService(store)

    const result = await service.store(makeFact(), fakeEmbedding)

    expect(result.outcome).toBe("inserted")
    expect(result.id).toBeTruthy()
    expect(store.upsert).toHaveBeenCalledOnce()
  })

  it("dedupes when a highly similar record exists", async () => {
    const existing = makeScoredRecord({}, 0.95) // above 0.92 threshold
    const store = mockStore([existing])
    const service = new MemoryService(store)

    const result = await service.store(makeFact(), fakeEmbedding)

    expect(result.outcome).toBe("deduped")
    expect(result.id).toBe(existing.id)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it("supersedes when similar and candidate is newer with higher confidence", async () => {
    const existing = makeScoredRecord(
      {
        id: "old-rec",
        confidence: 0.7,
        createdAt: new Date("2025-01-10T10:00:00Z").getTime(),
      },
      0.85, // above supersede minimum (0.75) but below dedup (0.92)
    )
    const store = mockStore([existing], makeRecord({ id: "old-rec" }))
    const service = new MemoryService(store)

    const fact = makeFact({
      confidence: 0.9,
      source: { sessionId: "sess-002", turnIndex: 1, timestamp: "2025-01-20T10:00:00Z" },
    })
    const result = await service.store(fact, fakeEmbedding)

    expect(result.outcome).toBe("superseded")
    expect(store.upsert).toHaveBeenCalledOnce()

    const upsertCalls = store.upsert.mock.calls as [MemoryRecord[], number[][]][]
    const upsertedRecord = upsertCalls[0]![0][0]!
    expect(upsertedRecord.supersedesId).toBe("old-rec")
  })

  it("inserts when similar but candidate is older (no supersession)", async () => {
    const existing = makeScoredRecord(
      {
        confidence: 0.9,
        createdAt: new Date("2025-01-20T10:00:00Z").getTime(),
      },
      0.85,
    )
    const store = mockStore([existing])
    const service = new MemoryService(store)

    const fact = makeFact({
      confidence: 0.7,
      source: { sessionId: "sess-002", turnIndex: 1, timestamp: "2025-01-05T10:00:00Z" },
    })
    const result = await service.store(fact, fakeEmbedding)

    // Not a dup (0.85 < 0.92), not superseding (candidate is older) → insert
    expect(result.outcome).toBe("inserted")
  })

  it("respects custom dupThreshold", async () => {
    const existing = makeScoredRecord({}, 0.8)
    const store = mockStore([existing])
    const service = new MemoryService(store, { dupThreshold: 0.8 })

    const result = await service.store(makeFact(), fakeEmbedding)
    expect(result.outcome).toBe("deduped")
  })

  it("merges metadata during supersession", async () => {
    const existing = makeScoredRecord(
      {
        id: "old-rec",
        tags: ["infra", "db"],
        people: ["alice"],
        projects: ["proj-a"],
        confidence: 0.7,
        createdAt: new Date("2025-01-10T10:00:00Z").getTime(),
      },
      0.85,
    )
    const store = mockStore(
      [existing],
      makeRecord({
        id: "old-rec",
        tags: ["infra", "db"],
        people: ["alice"],
        projects: ["proj-a"],
      }),
    )
    const service = new MemoryService(store)

    const fact = makeFact({
      confidence: 0.9,
      tags: ["db", "postgres"],
      people: ["bob"],
      projects: ["proj-a", "proj-b"],
      source: { sessionId: "sess-002", turnIndex: 1, timestamp: "2025-01-20T10:00:00Z" },
    })
    const result = await service.store(fact, fakeEmbedding)

    expect(result.outcome).toBe("superseded")
    const upsertCalls = store.upsert.mock.calls as [MemoryRecord[], number[][]][]
    const upserted = upsertCalls[0]![0][0]!
    expect(upserted.tags).toEqual(["infra", "db", "postgres"])
    expect(upserted.people).toEqual(["alice", "bob"])
    expect(upserted.projects).toEqual(["proj-a", "proj-b"])
  })
})

// ──────────────────────────────────────────────────
// MemoryService.search
// ──────────────────────────────────────────────────

describe("MemoryService.search", () => {
  it("delegates to store.search", async () => {
    const results = [makeScoredRecord({}, 0.9)]
    const store = mockStore(results)
    const service = new MemoryService(store)

    const found = await service.search(fakeEmbedding, 5)
    expect(found).toEqual(results)
    expect(store.search).toHaveBeenCalledWith(fakeEmbedding, { limit: 5 })
  })
})

// ──────────────────────────────────────────────────
// MemoryService.getByIds
// ──────────────────────────────────────────────────

describe("MemoryService.getByIds", () => {
  it("returns records for existing IDs", async () => {
    const record = makeRecord({ id: "rec-1" })
    const store = mockStore([], record)
    const service = new MemoryService(store)

    const results = await service.getByIds(["rec-1"])
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe("rec-1")
  })

  it("skips missing IDs", async () => {
    const store = mockStore([], null)
    const service = new MemoryService(store)

    const results = await service.getByIds(["missing-1", "missing-2"])
    expect(results).toHaveLength(0)
  })
})
