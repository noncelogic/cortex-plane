import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { chunkMarkdown } from "../memory/sync/chunker.js"
import { applyDiff, diff, loadState, saveState, type SyncState } from "../memory/sync/state.js"

describe("loadState / saveState", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sync-state-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns empty state when file does not exist", async () => {
    const state = await loadState(tempDir)
    expect(state.entries).toEqual({})
  })

  it("round-trips state through save and load", async () => {
    const state: SyncState = {
      entries: {
        abc123: {
          pointId: "uuid-1",
          filePath: "MEMORY.md",
          heading: "## Test",
          contentHash: "abc123",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    await saveState(tempDir, state)
    const loaded = await loadState(tempDir)
    expect(loaded).toEqual(state)
  })

  it("returns empty state for corrupted JSON", async () => {
    writeFileSync(join(tempDir, ".memory-sync-state.json"), "not valid json{{{")
    const state = await loadState(tempDir)
    expect(state.entries).toEqual({})
  })

  it("returns empty state for JSON without entries field", async () => {
    writeFileSync(join(tempDir, ".memory-sync-state.json"), '{"foo": "bar"}')
    const state = await loadState(tempDir)
    expect(state.entries).toEqual({})
  })
})

describe("diff", () => {
  const filePath = "MEMORY.md"

  function makeChunks(content: string) {
    return chunkMarkdown(content, filePath)
  }

  it("classifies all chunks as toCreate when state is empty", () => {
    const chunks = makeChunks(
      "## Section\n\nContent that is long enough to pass the minimum chunk threshold.",
    )
    const result = diff({ entries: {} }, chunks, filePath)
    expect(result.toCreate).toHaveLength(1)
    expect(result.toUpdate).toHaveLength(0)
    expect(result.toDelete).toHaveLength(0)
  })

  it("classifies unchanged chunks as neither create nor update", () => {
    const content = "## Section\n\nContent that is long enough to pass the minimum chunk threshold."
    const chunks = makeChunks(content)
    const chunk = chunks[0]!

    const state: SyncState = {
      entries: {
        [chunk.contentHash]: {
          pointId: chunk.id,
          filePath,
          heading: chunk.heading,
          contentHash: chunk.contentHash,
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const result = diff(state, chunks, filePath)
    expect(result.toCreate).toHaveLength(0)
    expect(result.toUpdate).toHaveLength(0)
    expect(result.toDelete).toHaveLength(0)
  })

  it("detects updated chunks (same heading path, different hash)", () => {
    const originalContent =
      "## Section\n\nOriginal content that is long enough to pass minimum chunk size for testing."
    const updatedContent =
      "## Section\n\nUpdated content that is long enough to pass minimum chunk size for testing."

    const originalChunks = makeChunks(originalContent)
    const updatedChunks = makeChunks(updatedContent)
    const original = originalChunks[0]!

    const state: SyncState = {
      entries: {
        [original.contentHash]: {
          pointId: original.id,
          filePath,
          heading: original.heading,
          contentHash: original.contentHash,
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const result = diff(state, updatedChunks, filePath)
    // The updated chunk has the same ID (same heading path) but different hash → toUpdate
    expect(result.toUpdate).toHaveLength(1)
    expect(result.toCreate).toHaveLength(0)
  })

  it("detects deleted chunks (in state but not in file)", () => {
    const fullContent =
      "## Section One\n\nFirst section content long enough for valid chunk.\n\n## Section Two\n\nSecond section content long enough for valid chunk."
    const partialContent = "## Section One\n\nFirst section content long enough for valid chunk."

    const fullChunks = makeChunks(fullContent)
    const partialChunks = makeChunks(partialContent)

    // Build state from full content
    const state: SyncState = { entries: {} }
    for (const chunk of fullChunks) {
      state.entries[chunk.contentHash] = {
        pointId: chunk.id,
        filePath,
        heading: chunk.heading,
        contentHash: chunk.contentHash,
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
      }
    }

    const result = diff(state, partialChunks, filePath)
    expect(result.toDelete).toHaveLength(1)
    expect(result.toDelete[0]!.heading).toBe("## Section Two")
  })

  it("ignores state entries from other files", () => {
    const chunks = makeChunks(
      "## Section\n\nContent long enough to pass minimum chunk size for testing.",
    )

    const state: SyncState = {
      entries: {
        otherhash: {
          pointId: "other-id",
          filePath: "OTHER.md",
          heading: "## Other",
          contentHash: "otherhash",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const result = diff(state, chunks, filePath)
    expect(result.toCreate).toHaveLength(1)
    expect(result.toDelete).toHaveLength(0) // Other file's entries are not affected
  })
})

describe("applyDiff", () => {
  const filePath = "MEMORY.md"

  it("adds entries for created chunks", () => {
    const chunks = chunkMarkdown(
      "## New\n\nNew content long enough to pass minimum chunk size.",
      filePath,
    )
    const chunk = chunks[0]!

    const state = applyDiff({ entries: {} }, filePath, [chunk], [], [])
    expect(state.entries[chunk.contentHash]).toBeDefined()
    expect(state.entries[chunk.contentHash]!.pointId).toBe(chunk.id)
  })

  it("removes entries for deleted chunks", () => {
    const state: SyncState = {
      entries: {
        oldhash: {
          pointId: "old-id",
          filePath,
          heading: "## Old",
          contentHash: "oldhash",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const newState = applyDiff(state, filePath, [], [], [state.entries["oldhash"]!])
    expect(newState.entries["oldhash"]).toBeUndefined()
  })

  it("replaces old hash entry with new hash for updated chunks", () => {
    // Chunk from original content — use real chunk ID
    const originalChunk = chunkMarkdown(
      "## Section\n\nOriginal content long enough to pass minimum chunk size.",
      filePath,
    )[0]!

    const state: SyncState = {
      entries: {
        [originalChunk.contentHash]: {
          pointId: originalChunk.id,
          filePath,
          heading: "## Section",
          contentHash: originalChunk.contentHash,
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const updatedChunk = chunkMarkdown(
      "## Section\n\nUpdated content long enough to pass minimum chunk size.",
      filePath,
    )[0]!

    const newState = applyDiff(state, filePath, [], [updatedChunk], [])
    expect(newState.entries[originalChunk.contentHash]).toBeUndefined()
    expect(newState.entries[updatedChunk.contentHash]).toBeDefined()
    expect(newState.entries[updatedChunk.contentHash]!.pointId).toBe(updatedChunk.id)
  })

  it("preserves entries from other files", () => {
    const state: SyncState = {
      entries: {
        otherhash: {
          pointId: "other-id",
          filePath: "OTHER.md",
          heading: "## Other",
          contentHash: "otherhash",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }

    const newState = applyDiff(state, filePath, [], [], [])
    expect(newState.entries["otherhash"]).toBeDefined()
  })
})
