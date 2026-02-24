import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"

import { watch, type FSWatcher } from "chokidar"

export interface WatcherConfig {
  /** Glob patterns to watch, relative to watchDir. Default: ['*.md', 'memory/*.md'] */
  patterns: string[]
  /** Debounce interval in ms. Default: 2000 */
  debounceMs: number
}

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  patterns: ["*.md", "memory/*.md"],
  debounceMs: 2000,
}

export interface WatcherEvents {
  onFileChanged: (filePath: string) => void | Promise<void>
  onFileDeleted: (filePath: string) => void | Promise<void>
}

export interface ManagedWatcher {
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Create a file watcher using chokidar with configurable debounce.
 *
 * - Watches glob patterns relative to watchDir.
 * - Debounces change events per-file (trailing edge, resets on new events).
 * - Distinguishes change vs delete by stat-checking after debounce fires.
 */
export function createWatcher(
  watchDir: string,
  events: WatcherEvents,
  config: Partial<WatcherConfig> = {},
): ManagedWatcher {
  const resolved: WatcherConfig = { ...DEFAULT_WATCHER_CONFIG, ...config }
  let watcher: FSWatcher | null = null
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function handleEvent(filePath: string): void {
    // Clear existing debounce timer for this file
    const existing = debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    debounceTimers.set(
      filePath,
      setTimeout(async () => {
        debounceTimers.delete(filePath)
        const absPath = resolve(watchDir, filePath)
        try {
          await stat(absPath)
          await events.onFileChanged(filePath)
        } catch {
          await events.onFileDeleted(filePath)
        }
      }, resolved.debounceMs),
    )
  }

  return {
    async start(): Promise<void> {
      const watchPaths = resolved.patterns.map((p) => join(watchDir, p))

      watcher = watch(watchPaths, {
        ignoreInitial: true,
        persistent: true,
        // Ignore state files and lock files
        ignored: [
          "**/.memory-sync-state.json",
          "**/.memory-sync.lock",
          "**/*.swp",
          "**/*~",
          "**/.#*",
          "**/node_modules/**",
          "**/.git/**",
        ],
      })

      watcher.on("add", (absPath) => {
        const rel = absPath.startsWith(watchDir)
          ? absPath.slice(watchDir.length + 1)
          : absPath
        handleEvent(rel)
      })

      watcher.on("change", (absPath) => {
        const rel = absPath.startsWith(watchDir)
          ? absPath.slice(watchDir.length + 1)
          : absPath
        handleEvent(rel)
      })

      watcher.on("unlink", (absPath) => {
        const rel = absPath.startsWith(watchDir)
          ? absPath.slice(watchDir.length + 1)
          : absPath

        // Clear any pending debounce and immediately fire delete
        const existing = debounceTimers.get(rel)
        if (existing) clearTimeout(existing)
        debounceTimers.delete(rel)

        void events.onFileDeleted(rel)
      })

      // Wait for chokidar to finish initial scan
      await new Promise<void>((res) => {
        watcher!.on("ready", res)
      })
    },

    async stop(): Promise<void> {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer)
      }
      debounceTimers.clear()

      if (watcher) {
        await watcher.close()
        watcher = null
      }
    },
  }
}

/**
 * Determine if a file change event was likely agent-originated.
 * If the agent set a write timestamp within `windowMs` of now, the change is agent-originated.
 */
export function isAgentOriginated(lastAgentWriteTs: number, windowMs: number = 3000): boolean {
  return Date.now() - lastAgentWriteTs < windowMs
}
