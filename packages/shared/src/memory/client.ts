import { QdrantClient } from "@qdrant/js-client-rest"

import { scoreMemory } from "./scoring.js"
import type { MemoryRecord, ScoredMemoryRecord } from "./types.js"

const VECTOR_SIZE = 1536
const COLLECTION_PREFIX = "agent_memory_"

export interface QdrantMemoryClientOptions {
  url?: string
  apiKey?: string
}

export class QdrantMemoryClient {
  readonly client: QdrantClient
  readonly collectionName: string

  constructor(agentSlug: string, options: QdrantMemoryClientOptions = {}) {
    this.client = new QdrantClient({
      url: options.url ?? process.env["QDRANT_URL"] ?? "http://localhost:6333",
      apiKey: options.apiKey ?? process.env["QDRANT_API_KEY"],
    })
    this.collectionName = `${COLLECTION_PREFIX}${agentSlug}`
  }

  async createCollection(): Promise<void> {
    await this.client.createCollection(this.collectionName, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
      quantization_config: {
        scalar: {
          type: "int8",
          quantile: 0.99,
          always_ram: true,
        },
      },
    })

    await Promise.all([
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "type",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "tags",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "people",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "projects",
        field_schema: "keyword",
      }),
      this.client.createPayloadIndex(this.collectionName, {
        field_name: "createdAt",
        field_schema: "integer",
      }),
    ])
  }

  async upsert(records: MemoryRecord[], vectors: number[][]): Promise<void> {
    if (records.length !== vectors.length) {
      throw new Error(
        `records.length (${records.length}) must match vectors.length (${vectors.length})`,
      )
    }

    const points = records.map((record, i) => ({
      id: record.id,
      vector: vectors[i]!,
      payload: { ...record },
    }))

    await this.client.upsert(this.collectionName, {
      wait: true,
      points,
    })
  }

  async search(
    vector: number[],
    options: {
      filter?: Record<string, unknown>
      limit?: number
    } = {},
  ): Promise<ScoredMemoryRecord[]> {
    const { filter, limit = 10 } = options

    const results = await this.client.search(this.collectionName, {
      vector,
      limit: limit * 3,
      filter: filter
        ? {
            must: Object.entries(filter).map(([key, value]) => ({
              key,
              match: { value },
            })),
          }
        : undefined,
      with_payload: true,
    })

    const now = Date.now()

    return results
      .map((result) => {
        const record = result.payload as unknown as MemoryRecord
        const similarity = result.score
        const score = scoreMemory(record, similarity, now)
        return { ...record, similarity, score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  async delete(ids: string[]): Promise<void> {
    await this.client.delete(this.collectionName, {
      wait: true,
      points: ids,
    })
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    try {
      const results = await this.client.retrieve(this.collectionName, {
        ids: [id],
        with_payload: true,
      })
      if (results.length === 0) return null
      return results[0]!.payload as unknown as MemoryRecord
    } catch {
      return null
    }
  }

  updateAccessCount(ids: string[]): void {
    const now = Date.now()
    for (const id of ids) {
      // Fire-and-forget: access count updates are not critical
      this.client
        .retrieve(this.collectionName, { ids: [id], with_payload: true })
        .then((results) => {
          if (results.length === 0) return
          const payload = results[0]!.payload as unknown as MemoryRecord
          return this.client.setPayload(this.collectionName, {
            payload: {
              accessCount: (payload.accessCount ?? 0) + 1,
              lastAccessedAt: now,
            },
            points: [id],
          })
        })
        .catch(() => {})
    }
  }
}
