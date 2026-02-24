import { createHash } from "node:crypto"

import { v5 as uuidv5 } from "uuid"

const MIN_CHUNK_SIZE = 32
const MAX_CHUNK_SIZE = 4096

/** Stable UUIDv5 namespace for markdown-sourced memory points. */
export const MEMORY_SYNC_NS = "d7b3d5a0-3e4a-4f9e-8c2b-1a5f6e7d8c9b"

export interface MarkdownChunk {
  /** UUIDv5 deterministic ID derived from filePath + heading path. */
  id: string
  /** Section heading text (e.g. "## Deployment Setup"). Null for preamble chunks. */
  heading: string | null
  /** Normalized chunk content (includes heading if present). */
  content: string
  /** Heading level (2 for ##, 0 for preamble). */
  level: number
  /** Ancestor heading path, e.g. ["MEMORY.md", "Deployment Setup"]. */
  path: string[]
  /** SHA-256 hex digest of the normalized content. */
  contentHash: string
}

/**
 * Normalize text for consistent hashing.
 * - Normalize line endings to \n
 * - Strip trailing whitespace per line
 * - Collapse 3+ consecutive newlines to 2
 * - Trim leading/trailing whitespace
 */
export function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** SHA-256 hex digest of the normalized text. */
export function contentHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex")
}

/** Generate a deterministic UUIDv5 point ID from file path + heading path. */
function chunkId(filePath: string, headingPath: string[]): string {
  const name = `${filePath}:${headingPath.join("/")}`
  return uuidv5(name, MEMORY_SYNC_NS)
}

interface RawSection {
  header: string | null
  body: string
  level: number
}

/** Split markdown body on ## headers, preserving preamble. */
function splitOnH2Headers(body: string): RawSection[] {
  const sections: RawSection[] = []
  let currentHeader: string | null = null
  let currentLevel = 0
  let currentLines: string[] = []

  for (const line of body.split("\n")) {
    const match = /^(#{2})\s+(.+)$/.exec(line)
    if (match) {
      // Flush previous section
      if (currentLines.length > 0 || currentHeader !== null) {
        sections.push({
          header: currentHeader,
          body: currentLines.join("\n"),
          level: currentLevel,
        })
      }
      currentHeader = line
      currentLevel = 2
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  // Flush final section
  if (currentLines.length > 0 || currentHeader !== null) {
    sections.push({
      header: currentHeader,
      body: currentLines.join("\n"),
      level: currentLevel,
    })
  }

  return sections
}

/** Split text at paragraph boundaries (double newlines) respecting maxSize. */
function splitAtParagraphBoundaries(text: string, maxSize: number): string[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let current = ""

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxSize && current) {
      chunks.push(current)
      current = paragraph
    } else {
      current = candidate
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

/** Strip a leading # title line from the body, returning [title, rest]. */
function extractH1Title(body: string): [string | null, string] {
  const match = /^#\s+(.+)\n?/.exec(body)
  if (match) {
    return [match[1]!, body.slice(match[0].length)]
  }
  return [null, body]
}

/**
 * Chunk a markdown file into semantically coherent pieces.
 *
 * - Splits on `##` headers (level 2).
 * - Preamble content (before the first `##`) becomes its own chunk.
 * - Sections exceeding MAX_CHUNK_SIZE are split at paragraph boundaries.
 * - Files with no `##` headers fall back to paragraph-level chunking.
 * - Chunks smaller than MIN_CHUNK_SIZE are discarded.
 */
export function chunkMarkdown(content: string, filePath: string): MarkdownChunk[] {
  const [title, body] = extractH1Title(content)
  const sections = splitOnH2Headers(body)
  const chunks: MarkdownChunk[] = []

  const fileBaseName = filePath.split("/").pop() ?? filePath

  // If there are no ## headers and only a preamble, fall back to paragraph chunking
  const hasHeaders = sections.some((s) => s.header !== null)

  if (!hasHeaders) {
    const normalizedBody = normalize(body)
    if (normalizedBody.length < MIN_CHUNK_SIZE) return chunks

    const paragraphChunks = splitAtParagraphBoundaries(normalizedBody, MAX_CHUNK_SIZE)
    for (const [i, text] of paragraphChunks.entries()) {
      const trimmed = normalize(text)
      if (trimmed.length < MIN_CHUNK_SIZE) continue

      const headingPath = [fileBaseName, `paragraph-${i}`]
      chunks.push({
        id: chunkId(filePath, headingPath),
        heading: null,
        content: trimmed,
        level: 0,
        path: headingPath,
        contentHash: contentHash(trimmed),
      })
    }
    return chunks
  }

  for (const section of sections) {
    const raw = section.header ? `${section.header}\n\n${section.body}` : section.body
    const text = normalize(raw)

    if (text.length < MIN_CHUNK_SIZE) continue

    // Extract heading text without the ## prefix for the path
    const headingText = section.header
      ? section.header.replace(/^#{1,6}\s+/, "").trim()
      : "preamble"

    const basePath = title ? [fileBaseName, title] : [fileBaseName]

    if (text.length > MAX_CHUNK_SIZE) {
      // Split oversized sections at paragraph boundaries
      const subChunks = splitAtParagraphBoundaries(text, MAX_CHUNK_SIZE)
      for (const [i, subText] of subChunks.entries()) {
        let finalText = subText
        // Prepend section header to sub-chunks that don't already include it
        if (section.header && !subText.startsWith(section.header)) {
          finalText = `${section.header}\n\n${subText}`
        }
        const trimmed = normalize(finalText)
        if (trimmed.length < MIN_CHUNK_SIZE) continue

        const headingPath = [...basePath, headingText, `part-${i}`]
        chunks.push({
          id: chunkId(filePath, headingPath),
          heading: section.header,
          content: trimmed,
          level: section.level || 0,
          path: headingPath,
          contentHash: contentHash(trimmed),
        })
      }
    } else {
      const headingPath = [...basePath, headingText]
      chunks.push({
        id: chunkId(filePath, headingPath),
        heading: section.header,
        content: text,
        level: section.level || 0,
        path: headingPath,
        contentHash: contentHash(text),
      })
    }
  }

  return chunks
}
