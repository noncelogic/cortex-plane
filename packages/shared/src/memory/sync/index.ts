export { chunkMarkdown, contentHash, MEMORY_SYNC_NS, normalize } from "./chunker.js"
export type { MarkdownChunk } from "./chunker.js"

export { applyDiff, diff, loadState, saveState } from "./state.js"
export type { DiffResult, SyncState, SyncStateEntry } from "./state.js"

export { createWatcher, isAgentOriginated } from "./watcher.js"
export type { ManagedWatcher, WatcherConfig, WatcherEvents } from "./watcher.js"

export { batchImport, deleteFile, initSync, syncFile } from "./sync.js"
export type { EmbeddingFn, SyncConfig, SyncOrchestrator, SyncResult } from "./sync.js"
