import { glob, readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { QdrantMemoryClient } from "../client.js"
import type { MemoryRecord } from "../types.js"
import { chunkMarkdown, type MarkdownChunk } from "./chunker.js"
import { applyDiff, diff, loadState, saveState, type SyncState } from "./state.js"
import { createWatcher, type ManagedWatcher } from "./watcher.js"

/** Embedding function injected by the caller — we don't hardcode the provider. */
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>

export interface SyncConfig {
  /** Glob patterns to watch. Default: ['*.md', 'memory/*.md'] */
  watchPaths: string[]
  /** Qdrant URL. */
  qdrantUrl: string
  /** Qdrant collection name. */
  collectionName: string
  /** Injected embedding function. */
  embeddingFn: EmbeddingFn
  /** Root directory to watch. */
  watchDir: string
  /** Debounce interval in ms. Default: 2000 */
  debounceMs?: number
}

export interface SyncResult {
  created: number
  updated: number
  deleted: number
  unchanged: number
}

/** Build a MemoryRecord payload from a markdown chunk (vector is handled separately). */
function chunkToPayload(chunk: MarkdownChunk): MemoryRecord {
  return {
    id: chunk.id,
    type: "fact",
    content: chunk.content,
    tags: [],
    people: [],
    projects: [],
    importance: 4,
    confidence: 1.0,
    source: "markdown_sync",
    createdAt: Date.now(),
    accessCount: 0,
    lastAccessedAt: Date.now(),
  }
}

/**
 * Sync a single file: chunk → diff → embed → upsert/delete → save state.
 */
export async function syncFile(
  filePath: string,
  watchDir: string,
  qdrant: QdrantMemoryClient,
  embeddingFn: EmbeddingFn,
  state: SyncState,
): Promise<{ state: SyncState; result: SyncResult }> {
  const absPath = resolve(watchDir, filePath)
  const content = await readFile(absPath, "utf-8")
  const chunks = chunkMarkdown(content, filePath)

  const { toCreate, toUpdate, toDelete } = diff(state, chunks, filePath)
  const unchanged = chunks.length - toCreate.length - toUpdate.length

  // Embed new and changed chunks
  const chunksToEmbed = [...toCreate, ...toUpdate]
  if (chunksToEmbed.length > 0) {
    const texts = chunksToEmbed.map((c) => c.content)
    const vectors = await embeddingFn(texts)

    const records = chunksToEmbed.map((chunk) => chunkToPayload(chunk))
    await qdrant.upsert(records, vectors)
  }

  // Delete orphaned points
  if (toDelete.length > 0) {
    const idsToDelete = toDelete.map((e) => e.pointId)
    await qdrant.delete(idsToDelete)
  }

  // Update state
  const newState = applyDiff(state, filePath, toCreate, toUpdate, toDelete)

  return {
    state: newState,
    result: {
      created: toCreate.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
      unchanged,
    },
  }
}

/**
 * Handle file deletion: remove all Qdrant points for that file and clean state.
 */
export async function deleteFile(
  filePath: string,
  qdrant: QdrantMemoryClient,
  state: SyncState,
): Promise<SyncState> {
  // Find all state entries for this file
  const idsToDelete: string[] = []
  const newEntries = { ...state.entries }

  for (const [hash, entry] of Object.entries(newEntries)) {
    if (entry.filePath === filePath) {
      idsToDelete.push(entry.pointId)
      delete newEntries[hash]
    }
  }

  if (idsToDelete.length > 0) {
    await qdrant.delete(idsToDelete)
  }

  return { entries: newEntries }
}

/**
 * Batch import all matching files from a directory.
 * Used for initial seeding when no sync state exists.
 */
export async function batchImport(
  directory: string,
  patterns: string[],
  qdrant: QdrantMemoryClient,
  embeddingFn: EmbeddingFn,
): Promise<{ state: SyncState; results: Map<string, SyncResult> }> {
  // Resolve glob patterns to actual files
  const files: string[] = []
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: directory })) {
      if (!files.includes(entry)) {
        files.push(entry)
      }
    }
  }

  let state: SyncState = { entries: {} }
  const results = new Map<string, SyncResult>()

  for (const filePath of files.sort()) {
    const result = await syncFile(filePath, directory, qdrant, embeddingFn, state)
    state = result.state
    results.set(filePath, result.result)
  }

  await saveState(directory, state)

  return { state, results }
}

export interface SyncOrchestrator {
  /** Start watching and syncing. */
  start(): Promise<void>
  /** Stop the watcher and save state. */
  stop(): Promise<void>
  /** Record that the agent just wrote to a file (for human-wins detection). */
  setAgentWriteTimestamp(): void
}

/**
 * Initialize the full sync system: load state, batch import if first run,
 * then start watching for changes.
 */
export function initSync(qdrant: QdrantMemoryClient, config: SyncConfig): SyncOrchestrator {
  let state: SyncState = { entries: {} }
  let watcher: ManagedWatcher | null = null
  let _lastAgentWriteTs = 0

  return {
    async start(): Promise<void> {
      state = await loadState(config.watchDir)

      // If state is empty, do a batch import
      const isFirstRun = Object.keys(state.entries).length === 0
      if (isFirstRun) {
        const importResult = await batchImport(
          config.watchDir,
          config.watchPaths,
          qdrant,
          config.embeddingFn,
        )
        state = importResult.state
      }

      // Start file watcher
      watcher = createWatcher(
        config.watchDir,
        {
          onFileChanged: async (filePath) => {
            // 'Human Wins': if this was agent-originated within 3s, still sync
            // but the sync is the same code path — idempotent.
            const result = await syncFile(
              filePath,
              config.watchDir,
              qdrant,
              config.embeddingFn,
              state,
            )
            state = result.state
            await saveState(config.watchDir, state)
          },
          onFileDeleted: async (filePath) => {
            state = await deleteFile(filePath, qdrant, state)
            await saveState(config.watchDir, state)
          },
        },
        {
          patterns: config.watchPaths,
          debounceMs: config.debounceMs ?? 2000,
        },
      )

      await watcher.start()
    },

    async stop(): Promise<void> {
      if (watcher) {
        await watcher.stop()
        watcher = null
      }
      await saveState(config.watchDir, state)
    },

    setAgentWriteTimestamp(): void {
      _lastAgentWriteTs = Date.now()
    },
  }
}
