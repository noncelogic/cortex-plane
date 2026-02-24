import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { MarkdownChunk } from "./chunker.js"

export interface SyncStateEntry {
  /** Qdrant point ID (UUIDv5). */
  pointId: string
  /** Source file path relative to watch root. */
  filePath: string
  /** Section heading text. */
  heading: string | null
  /** SHA-256 content hash at last sync. */
  contentHash: string
  /** ISO 8601 timestamp of last successful sync. */
  lastSyncedAt: string
}

/** Full sync state, keyed by contentHash for fast lookup. */
export interface SyncState {
  /** Map: contentHash → SyncStateEntry */
  entries: Record<string, SyncStateEntry>
}

export interface DiffResult {
  /** New chunks not present in previous state. */
  toCreate: MarkdownChunk[]
  /** Chunks whose content changed (same heading path, different hash). */
  toUpdate: MarkdownChunk[]
  /** State entries with no matching chunk in the current file — to be deleted from Qdrant. */
  toDelete: SyncStateEntry[]
}

const STATE_FILENAME = ".memory-sync-state.json"

/** Load sync state from disk. Returns empty state if file doesn't exist or is corrupt. */
export async function loadState(watchDir: string): Promise<SyncState> {
  const filePath = join(watchDir, STATE_FILENAME)
  try {
    const raw = await readFile(filePath, "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && "entries" in parsed) {
      return parsed as SyncState
    }
    return { entries: {} }
  } catch {
    return { entries: {} }
  }
}

/** Persist sync state to disk (atomic write isn't critical — idempotent IDs protect us). */
export async function saveState(watchDir: string, state: SyncState): Promise<void> {
  const filePath = join(watchDir, STATE_FILENAME)
  await writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8")
}

/**
 * Diff the current chunks for a single file against the persisted state.
 *
 * - Chunks with a contentHash not in state → toCreate
 * - Chunks whose pointId exists in state but with a different hash → toUpdate
 * - State entries for this file not represented in current chunks → toDelete
 */
export function diff(state: SyncState, newChunks: MarkdownChunk[], filePath: string): DiffResult {
  const toCreate: MarkdownChunk[] = []
  const toUpdate: MarkdownChunk[] = []

  // Collect all state entries that belong to this file
  const fileEntries = new Map<string, SyncStateEntry>()
  for (const entry of Object.values(state.entries)) {
    if (entry.filePath === filePath) {
      fileEntries.set(entry.pointId, entry)
    }
  }

  // Set of point IDs that are still present in the current file
  const seenPointIds = new Set<string>()

  for (const chunk of newChunks) {
    seenPointIds.add(chunk.id)

    // Check if this exact content already exists in state
    const existingByHash = state.entries[chunk.contentHash]
    if (existingByHash && existingByHash.filePath === filePath) {
      // Content unchanged — no-op
      continue
    }

    // Check if this point ID already exists (same heading path, different content)
    const existingByPointId = fileEntries.get(chunk.id)
    if (existingByPointId) {
      // Same location, different content → update
      toUpdate.push(chunk)
    } else {
      // Completely new chunk
      toCreate.push(chunk)
    }
  }

  // State entries for this file whose pointId is not in the current chunks → delete
  const toDelete: SyncStateEntry[] = []
  for (const entry of fileEntries.values()) {
    if (!seenPointIds.has(entry.pointId)) {
      toDelete.push(entry)
    }
  }

  return { toCreate, toUpdate, toDelete }
}

/**
 * Apply a diff result to the state, returning a new state object.
 * Called after successful Qdrant operations.
 */
export function applyDiff(
  state: SyncState,
  filePath: string,
  created: MarkdownChunk[],
  updated: MarkdownChunk[],
  deleted: SyncStateEntry[],
): SyncState {
  const newEntries = { ...state.entries }
  const now = new Date().toISOString()

  // Remove deleted entries
  for (const entry of deleted) {
    delete newEntries[entry.contentHash]
  }

  // Remove old hashes for updated chunks (the old hash entry is stale)
  for (const chunk of updated) {
    // Find and remove the old entry for this pointId
    for (const [hash, entry] of Object.entries(newEntries)) {
      if (entry.pointId === chunk.id && entry.filePath === filePath) {
        delete newEntries[hash]
        break
      }
    }
  }

  // Add/update entries for created and updated chunks
  for (const chunk of [...created, ...updated]) {
    newEntries[chunk.contentHash] = {
      pointId: chunk.id,
      filePath,
      heading: chunk.heading,
      contentHash: chunk.contentHash,
      lastSyncedAt: now,
    }
  }

  return { entries: newEntries }
}
