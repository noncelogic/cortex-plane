import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { QdrantMemoryClient } from "../memory/client.js"
import type { MemoryRecord } from "../memory/types.js"

const QDRANT_URL = process.env["QDRANT_URL"] ?? "http://localhost:6333"
const TEST_SLUG = "integration-test"

async function isQdrantAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${QDRANT_URL}/healthz`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const qdrantAvailable = await isQdrantAvailable()

function makeVector(seed: number): number[] {
  const vec = new Array<number>(1536).fill(0)
  for (let i = 0; i < vec.length; i++) {
    vec[i] = Math.sin(seed * (i + 1))
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  return vec.map((v) => v / norm)
}

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    type: "fact",
    content: "Test memory",
    tags: ["test"],
    people: [],
    projects: [],
    importance: 3,
    confidence: 0.9,
    source: "integration-test",
    createdAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
    ...overrides,
  }
}

describe.skipIf(!qdrantAvailable)("QdrantMemoryClient integration", () => {
  let client: QdrantMemoryClient

  beforeAll(async () => {
    client = new QdrantMemoryClient(TEST_SLUG, { url: QDRANT_URL })

    // Clean up from previous test runs
    try {
      await client.client.deleteCollection(client.collectionName)
    } catch {
      // Collection may not exist
    }

    await client.createCollection()
  })

  afterAll(async () => {
    try {
      await client.client.deleteCollection(client.collectionName)
    } catch {
      // Ignore cleanup errors
    }
  })

  it("creates the collection with correct config", async () => {
    const info = await client.client.getCollection(client.collectionName)
    expect(info.config.params.vectors).toMatchObject({
      size: 1536,
      distance: "Cosine",
    })
  })

  it("upserts and retrieves a record by ID", async () => {
    const record = makeRecord("00000000-0000-7000-8000-000000000001", {
      content: "The k8s cluster runs on ARM64 nodes",
    })
    const vector = makeVector(1)

    await client.upsert([record], [vector])

    const retrieved = await client.getById(record.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.content).toBe("The k8s cluster runs on ARM64 nodes")
    expect(retrieved!.type).toBe("fact")
  })

  it("searches for similar vectors", async () => {
    const records = [
      makeRecord("00000000-0000-7000-8000-000000000010", {
        content: "User prefers TypeScript",
        type: "preference",
      }),
      makeRecord("00000000-0000-7000-8000-000000000011", {
        content: "Project uses Fastify",
        type: "fact",
      }),
    ]
    const vectors = [makeVector(10), makeVector(11)]

    await client.upsert(records, vectors)

    // Search with a vector similar to the first record
    const results = await client.search(makeVector(10), { limit: 5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.id).toBe("00000000-0000-7000-8000-000000000010")
  })

  it("deletes records by ID", async () => {
    const id = "00000000-0000-7000-8000-000000000020"
    const record = makeRecord(id, { content: "To be deleted" })
    await client.upsert([record], [makeVector(20)])

    const beforeDelete = await client.getById(id)
    expect(beforeDelete).not.toBeNull()

    await client.delete([id])

    const afterDelete = await client.getById(id)
    expect(afterDelete).toBeNull()
  })

  it("returns null for non-existent ID", async () => {
    const result = await client.getById("00000000-0000-7000-8000-ffffffffffff")
    expect(result).toBeNull()
  })

  it("throws when record/vector count mismatch", async () => {
    const records = [makeRecord("00000000-0000-7000-8000-000000000030")]
    const vectors = [makeVector(30), makeVector(31)]

    await expect(client.upsert(records, vectors)).rejects.toThrow("must match")
  })
})
