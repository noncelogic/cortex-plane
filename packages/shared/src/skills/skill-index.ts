/**
 * SkillIndex — in-memory metadata index with mtime-based cache invalidation.
 *
 * Scans a skills directory for SKILL.md files, maintains a lightweight
 * metadata index, and supports on-demand full content loading.
 *
 * Directory structure:
 *   {skillsDir}/
 *     code-review/SKILL.md
 *     shell-ops/SKILL.md
 *     research/SKILL.md
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { loadSkillFile, loadSkillMetadata } from "./loader.js"
import type { SkillDefinition, SkillMetadata } from "./types.js"

export class SkillIndex {
  private readonly skillsDir: string
  private readonly entries = new Map<string, SkillMetadata>()
  private initialized = false

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
  }

  /**
   * Scan the skills directory and build/refresh the metadata index.
   * Uses mtime comparison to skip unchanged files.
   */
  async refresh(): Promise<void> {
    let dirs: string[]
    try {
      dirs = await readdir(this.skillsDir)
    } catch {
      // Skills directory doesn't exist yet — start empty.
      this.entries.clear()
      this.initialized = true
      return
    }

    const seen = new Set<string>()

    for (const entry of dirs) {
      const skillMdPath = join(this.skillsDir, entry, "SKILL.md")
      try {
        const fileStat = await stat(skillMdPath)
        if (!fileStat.isFile()) continue

        seen.add(entry)

        // Check mtime — skip if unchanged
        const existing = this.entries.get(entry)
        if (existing && existing.mtimeMs === fileStat.mtimeMs) {
          continue
        }

        // (Re-)load metadata
        const metadata = await loadSkillMetadata(skillMdPath)
        this.entries.set(entry, metadata)
      } catch {
        // No SKILL.md in this directory — skip.
      }
    }

    // Remove entries for deleted skills
    for (const name of this.entries.keys()) {
      if (!seen.has(name)) {
        this.entries.delete(name)
      }
    }

    this.initialized = true
  }

  /** Get all indexed skill metadata entries. */
  getAll(): SkillMetadata[] {
    return [...this.entries.values()]
  }

  /** Get skill metadata by name. */
  getByName(name: string): SkillMetadata | undefined {
    return this.entries.get(name)
  }

  /** Get skills matching any of the given tags. */
  getByTags(tags: string[]): SkillMetadata[] {
    const tagSet = new Set(tags)
    return this.getAll().filter((s) => s.tags.some((t) => tagSet.has(t)))
  }

  /** Number of indexed skills. */
  get size(): number {
    return this.entries.size
  }

  /** Whether the index has been initialized via refresh(). */
  get isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Load full skill definitions for the given skill names.
   * Only loads content for requested skills (progressive disclosure).
   */
  async resolve(names: string[]): Promise<SkillDefinition[]> {
    const results: SkillDefinition[] = []

    for (const name of names) {
      const meta = this.entries.get(name)
      if (!meta) continue

      try {
        const def = await loadSkillFile(meta.filePath)
        results.push(def)
      } catch {
        // Skill file may have been deleted since last index — skip.
      }
    }

    return results
  }

  /**
   * Invalidate a specific skill entry, forcing re-read on next refresh().
   */
  invalidate(name: string): void {
    const entry = this.entries.get(name)
    if (entry) {
      // Set mtime to 0 to force re-read on next refresh
      this.entries.set(name, { ...entry, mtimeMs: 0 })
    }
  }

  /** Remove all entries from the index. */
  clear(): void {
    this.entries.clear()
    this.initialized = false
  }
}
