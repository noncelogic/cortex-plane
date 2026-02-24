import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { QdrantMemoryClient } from "../memory/client.js"
import type { MemoryRecord } from "../memory/types.js"
import { batchImport, deleteFile, syncFile, type EmbeddingFn } from "../memory/sync/sync.js"
import { loadState, type SyncState } from "../memory/sync/state.js"

/** Create a mock QdrantMemoryClient. */
function mockQdrant(): QdrantMemoryClient {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    updateAccessCount: vi.fn(),
    client: {} as QdrantMemoryClient["client"],
    collectionName: "test_collection",
    createCollection: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantMemoryClient
}

/** Mock embedding function that returns deterministic fake vectors. */
const mockEmbeddingFn: EmbeddingFn = async (texts) => {
  return texts.map((_, i) => Array.from({ length: 1536 }, (_, j) => (i + j) * 0.001))
}

describe("syncFile", () => {
  let tempDir: string
  let qdrant: QdrantMemoryClient

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sync-file-"))
    qdrant = mockQdrant()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates chunks for a new file (empty state)", async () => {
    writeFileSync(
      join(tempDir, "MEMORY.md"),
      "## Preferences\n\nAlways use TypeScript strict mode in all projects.\n\n## Deployment\n\nUse k3s on ARM64 nodes for production workloads.\n",
    )

    const { state, result } = await syncFile(
      "MEMORY.md",
      tempDir,
      qdrant,
      mockEmbeddingFn,
      { entries: {} },
    )

    expect(result.created).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.deleted).toBe(0)
    expect(qdrant.upsert).toHaveBeenCalledOnce()

    // State should have 2 entries
    expect(Object.keys(state.entries)).toHaveLength(2)

    // Upsert should be called with 2 records and 2 vectors
    const upsertCall = vi.mocked(qdrant.upsert).mock.calls[0]!
    expect(upsertCall[0]).toHaveLength(2)
    expect(upsertCall[1]).toHaveLength(2)

    // All records should have source = 'markdown_sync'
    for (const record of upsertCall[0] as MemoryRecord[]) {
      expect(record.source).toBe("markdown_sync")
      expect(record.confidence).toBe(1.0)
    }
  })

  it("detects no changes when content is unchanged", async () => {
    const content = "## Section\n\nContent that is long enough to pass the minimum chunk threshold."
    writeFileSync(join(tempDir, "test.md"), content)

    // First sync — creates
    const first = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, { entries: {} })
    expect(first.result.created).toBe(1)

    // Second sync with same state — no changes
    const second = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, first.state)
    expect(second.result.created).toBe(0)
    expect(second.result.updated).toBe(0)
    expect(second.result.deleted).toBe(0)
    expect(second.result.unchanged).toBe(1)

    // upsert should only have been called once (from first sync)
    expect(qdrant.upsert).toHaveBeenCalledOnce()
  })

  it("detects updated content", async () => {
    writeFileSync(
      join(tempDir, "test.md"),
      "## Section\n\nOriginal content that is long enough to pass minimum chunk size.",
    )

    const first = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, { entries: {} })

    // Modify the file
    writeFileSync(
      join(tempDir, "test.md"),
      "## Section\n\nUpdated content that is long enough to pass minimum chunk size.",
    )

    const second = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, first.state)
    expect(second.result.updated).toBe(1)
    expect(second.result.created).toBe(0)
  })

  it("detects deleted sections", async () => {
    writeFileSync(
      join(tempDir, "test.md"),
      "## Section One\n\nFirst section long enough for valid chunk.\n\n## Section Two\n\nSecond section long enough for valid chunk.",
    )

    const first = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, { entries: {} })
    expect(first.result.created).toBe(2)

    // Remove section two
    writeFileSync(
      join(tempDir, "test.md"),
      "## Section One\n\nFirst section long enough for valid chunk.",
    )

    const second = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, first.state)
    expect(second.result.deleted).toBe(1)
    expect(qdrant.delete).toHaveBeenCalledOnce()
  })

  it("produces deterministic IDs (idempotent upserts)", async () => {
    const content = "## Section\n\nSame content for idempotency testing with enough chars."
    writeFileSync(join(tempDir, "test.md"), content)

    const first = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, { entries: {} })
    const firstRecords = vi.mocked(qdrant.upsert).mock.calls[0]![0] as MemoryRecord[]
    const firstId = firstRecords[0]!.id

    // Reset mock and sync again from empty state — should produce same ID
    vi.mocked(qdrant.upsert).mockClear()
    const second = await syncFile("test.md", tempDir, qdrant, mockEmbeddingFn, { entries: {} })
    const secondRecords = vi.mocked(qdrant.upsert).mock.calls[0]![0] as MemoryRecord[]
    const secondId = secondRecords[0]!.id

    expect(firstId).toBe(secondId)
  })
})

describe("deleteFile", () => {
  it("deletes all Qdrant points for the file and cleans state", async () => {
    const qdrant = mockQdrant()
    const state: SyncState = {
      entries: {
        hash1: {
          pointId: "id-1",
          filePath: "MEMORY.md",
          heading: "## One",
          contentHash: "hash1",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
        hash2: {
          pointId: "id-2",
          filePath: "MEMORY.md",
          heading: "## Two",
          contentHash: "hash2",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
        hash3: {
          pointId: "id-3",
          filePath: "OTHER.md",
          heading: "## Other",
          contentHash: "hash3",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const newState = await deleteFile("MEMORY.md", qdrant, state)

    // Should delete only MEMORY.md points
    expect(qdrant.delete).toHaveBeenCalledWith(["id-1", "id-2"])

    // State should only contain OTHER.md entries
    expect(Object.keys(newState.entries)).toHaveLength(1)
    expect(newState.entries["hash3"]).toBeDefined()
  })

  it("does nothing when file has no entries in state", async () => {
    const qdrant = mockQdrant()
    const state: SyncState = { entries: {} }

    const newState = await deleteFile("MEMORY.md", qdrant, state)
    expect(qdrant.delete).not.toHaveBeenCalled()
    expect(newState.entries).toEqual({})
  })
})

describe("batchImport", () => {
  let tempDir: string
  let qdrant: QdrantMemoryClient

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "batch-import-"))
    qdrant = mockQdrant()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("imports all matching files", async () => {
    writeFileSync(
      join(tempDir, "MEMORY.md"),
      "## Facts\n\nThe sky is blue and this is a long enough fact for chunking.",
    )
    writeFileSync(
      join(tempDir, "NOTES.md"),
      "## Notes\n\nSome important notes that are long enough for valid chunking.",
    )

    const { state, results } = await batchImport(tempDir, ["*.md"], qdrant, mockEmbeddingFn)

    expect(results.size).toBe(2)
    expect(Object.keys(state.entries).length).toBeGreaterThanOrEqual(2)

    // State file should be persisted
    const loaded = await loadState(tempDir)
    expect(Object.keys(loaded.entries).length).toBeGreaterThanOrEqual(2)
  })

  it("handles empty directory", async () => {
    const { state, results } = await batchImport(tempDir, ["*.md"], qdrant, mockEmbeddingFn)
    expect(results.size).toBe(0)
    expect(Object.keys(state.entries)).toHaveLength(0)
  })

  it("is idempotent — re-import produces same IDs", async () => {
    writeFileSync(
      join(tempDir, "test.md"),
      "## Section\n\nContent for idempotency testing with enough length.",
    )

    const first = await batchImport(tempDir, ["*.md"], qdrant, mockEmbeddingFn)
    const firstIds = Object.values(first.state.entries).map((e) => e.pointId)

    vi.mocked(qdrant.upsert).mockClear()

    const second = await batchImport(tempDir, ["*.md"], qdrant, mockEmbeddingFn)
    const secondIds = Object.values(second.state.entries).map((e) => e.pointId)

    expect(firstIds).toEqual(secondIds)
  })
})
