import { randomUUID } from "node:crypto"

import { isDuplicate, mergeMetadata, shouldSupersede } from "./dedup.js"
import type { AtomicFact } from "./schemas.js"
import type { MemoryRecord, MemoryType, ScoredMemoryRecord } from "./types.js"

// ──────────────────────────────────────────────────
// Memory store interface (for testability)
// ──────────────────────────────────────────────────

export interface MemoryStore {
  upsert(records: MemoryRecord[], vectors: number[][]): Promise<void>
  search(
    vector: number[],
    options?: { filter?: Record<string, unknown>; limit?: number },
  ): Promise<ScoredMemoryRecord[]>
  getById(id: string): Promise<MemoryRecord | null>
  delete(ids: string[]): Promise<void>
}

// ──────────────────────────────────────────────────
// Store result types
// ──────────────────────────────────────────────────

export type StoreOutcome = "inserted" | "deduped" | "superseded"

export interface StoreResult {
  id: string
  outcome: StoreOutcome
}

// ──────────────────────────────────────────────────
// Fact → MemoryRecord conversion
// ──────────────────────────────────────────────────

/** Map extraction types to storage types (lesson/relationship → fact). */
function toMemoryType(type: AtomicFact["type"]): MemoryType {
  if (type === "lesson" || type === "relationship") return "fact"
  return type
}

export function factToRecord(fact: AtomicFact, id?: string): MemoryRecord {
  return {
    id: id ?? randomUUID(),
    type: toMemoryType(fact.type),
    content: fact.content,
    tags: fact.tags,
    people: fact.people,
    projects: fact.projects,
    importance: fact.importance as MemoryRecord["importance"],
    confidence: fact.confidence,
    source: `session:${fact.source.sessionId}:${fact.source.turnIndex}`,
    createdAt: new Date(fact.source.timestamp).getTime() || Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
  }
}

// ──────────────────────────────────────────────────
// MemoryService
// ──────────────────────────────────────────────────

const DEFAULT_DEDUP_THRESHOLD = 0.92
const DEFAULT_SUPERSEDE_MIN = 0.75

export interface MemoryServiceOptions {
  dupThreshold?: number
  supersedeMin?: number
}

export class MemoryService {
  private readonly backend: MemoryStore
  private readonly dupThreshold: number
  private readonly supersedeMin: number

  constructor(store: MemoryStore, options: MemoryServiceOptions = {}) {
    this.backend = store
    this.dupThreshold = options.dupThreshold ?? DEFAULT_DEDUP_THRESHOLD
    this.supersedeMin = options.supersedeMin ?? DEFAULT_SUPERSEDE_MIN
  }

  /**
   * Store a fact with dedup and supersession checks.
   * Returns the record ID and whether it was inserted, deduped, or superseded.
   */
  async store(fact: AtomicFact, embedding: number[]): Promise<StoreResult> {
    // Search for near-duplicates
    const candidates = await this.backend.search(embedding, { limit: 5 })

    for (const existing of candidates) {
      const sim = existing.similarity

      // Exact duplicate — skip
      if (isDuplicate(sim, this.dupThreshold)) {
        return { id: existing.id, outcome: "deduped" }
      }

      // Similar enough to consider supersession
      if (sim >= this.supersedeMin && shouldSupersede(existing, fact)) {
        return this.supersede(existing.id, fact, embedding)
      }
    }

    // Novel fact — insert
    const record = factToRecord(fact)
    await this.backend.upsert([record], [embedding])
    return { id: record.id, outcome: "inserted" }
  }

  /**
   * Mark an existing record as superseded and insert the new fact.
   */
  async supersede(oldId: string, newFact: AtomicFact, embedding: number[]): Promise<StoreResult> {
    const existing = await this.backend.getById(oldId)
    const record = factToRecord(newFact)

    if (existing) {
      const merged = mergeMetadata(existing, newFact)
      record.tags = merged.tags
      record.people = merged.people
      record.projects = merged.projects
      record.supersedesId = oldId
    }

    // Insert new record (old remains for audit but is logically replaced)
    await this.backend.upsert([record], [embedding])
    return { id: record.id, outcome: "superseded" }
  }

  /**
   * Search memories by embedding vector.
   */
  async search(embedding: number[], limit = 10): Promise<ScoredMemoryRecord[]> {
    return this.backend.search(embedding, { limit })
  }

  /**
   * Get memory records by their IDs.
   */
  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = []
    for (const id of ids) {
      const record = await this.backend.getById(id)
      if (record) results.push(record)
    }
    return results
  }
}
