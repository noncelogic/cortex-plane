/**
 * SKILL.md loader — parses frontmatter metadata and body content.
 *
 * SKILL.md format:
 * ```
 * ---
 * title: Code Review
 * tags: [review, quality]
 * summary: Reviews code for quality, security, and correctness
 * allowedTools: [Read, Grep, Glob]
 * deniedTools: [Write, Edit, Bash]
 * networkAccess: false
 * shellAccess: false
 * ---
 * # Full skill instructions here...
 * ```
 *
 * Uses a minimal frontmatter parser (no external YAML dependency)
 * that handles the limited subset needed for skill metadata.
 */

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"

import type { SkillConstraints, SkillDefinition, SkillMetadata } from "./types.js"

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/** Regex to match YAML frontmatter delimited by --- */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface RawFrontmatter {
  title?: string
  tags?: string[]
  summary?: string
  allowedTools?: string[]
  deniedTools?: string[]
  networkAccess?: boolean
  shellAccess?: boolean
}

/**
 * Parse a simple YAML-subset frontmatter block.
 * Handles: string values, inline arrays `[a, b]`, and booleans.
 */
export function parseFrontmatter(raw: string): RawFrontmatter {
  const result: Record<string, unknown> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()

    if (!key) continue

    result[key] = parseValue(value)
  }

  return result as RawFrontmatter
}

function parseValue(value: string): string | boolean | string[] {
  // Boolean
  if (value === "true") return true
  if (value === "false") return false

  // Inline array: [item1, item2, item3]
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }

  // String (strip quotes if present)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

// ---------------------------------------------------------------------------
// SKILL.md loading
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md string into metadata and body content.
 * The skill `name` is derived from the parent directory name.
 */
export function parseSkillMd(
  raw: string,
  filePath: string,
  mtimeMs: number,
): { metadata: SkillMetadata; content: string } {
  const match = FRONTMATTER_RE.exec(raw)

  if (!match) {
    // No frontmatter — treat entire file as content with minimal metadata
    const name = basename(dirname(filePath))
    return {
      metadata: {
        name,
        title: name,
        tags: [],
        summary: "",
        constraints: defaultConstraints(),
        contentHash: hashContent(raw),
        mtimeMs,
        filePath,
      },
      content: raw,
    }
  }

  const fm = parseFrontmatter(match[1]!)
  const body = match[2]!
  const name = basename(dirname(filePath))

  const constraints: SkillConstraints = {
    allowedTools: Array.isArray(fm.allowedTools) ? fm.allowedTools : [],
    deniedTools: Array.isArray(fm.deniedTools) ? fm.deniedTools : [],
    networkAccess: typeof fm.networkAccess === "boolean" ? fm.networkAccess : false,
    shellAccess: typeof fm.shellAccess === "boolean" ? fm.shellAccess : true,
  }

  return {
    metadata: {
      name,
      title: typeof fm.title === "string" ? fm.title : name,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      summary: typeof fm.summary === "string" ? fm.summary : "",
      constraints,
      contentHash: hashContent(raw),
      mtimeMs,
      filePath,
    },
    content: body,
  }
}

/**
 * Load a SKILL.md file from disk, returning metadata and full content.
 */
export async function loadSkillFile(filePath: string): Promise<SkillDefinition> {
  const [raw, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)])

  const { metadata, content } = parseSkillMd(raw, filePath, fileStat.mtimeMs)
  return { metadata, content }
}

/**
 * Load only metadata from a SKILL.md file (reads file but discards body).
 */
export async function loadSkillMetadata(filePath: string): Promise<SkillMetadata> {
  const def = await loadSkillFile(filePath)
  return def.metadata
}

function defaultConstraints(): SkillConstraints {
  return {
    allowedTools: [],
    deniedTools: [],
    networkAccess: false,
    shellAccess: true,
  }
}
