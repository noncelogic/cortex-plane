import { describe, expect, it } from "vitest"

import { chunkMarkdown, contentHash, MEMORY_SYNC_NS, normalize } from "../memory/sync/chunker.js"

describe("normalize", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalize("  hello  ")).toBe("hello")
  })

  it("normalizes \\r\\n to \\n", () => {
    expect(normalize("line1\r\nline2")).toBe("line1\nline2")
  })

  it("strips trailing whitespace per line", () => {
    expect(normalize("hello   \nworld   ")).toBe("hello\nworld")
  })

  it("collapses 3+ newlines to 2", () => {
    expect(normalize("a\n\n\n\nb")).toBe("a\n\nb")
  })

  it("preserves double newlines", () => {
    expect(normalize("a\n\nb")).toBe("a\n\nb")
  })
})

describe("contentHash", () => {
  it("returns a 64-char hex string", () => {
    const hash = contentHash("hello world")
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic", () => {
    expect(contentHash("test")).toBe(contentHash("test"))
  })

  it("differs for different content", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"))
  })

  it("normalizes before hashing — whitespace differences produce the same hash", () => {
    expect(contentHash("hello  \n  world")).toBe(contentHash("hello\n  world"))
  })
})

describe("chunkMarkdown", () => {
  it("splits on ## headers", () => {
    const md = `# Title

## Section One

Content of section one.

## Section Two

Content of section two.
`
    const chunks = chunkMarkdown(md, "test.md")
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.heading).toBe("## Section One")
    expect(chunks[0]!.content).toContain("Content of section one")
    expect(chunks[1]!.heading).toBe("## Section Two")
    expect(chunks[1]!.content).toContain("Content of section two")
  })

  it("preserves heading hierarchy in path", () => {
    const md = `# My Memory

## Preferences

I prefer TypeScript.
`
    const chunks = chunkMarkdown(md, "MEMORY.md")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.path).toContain("My Memory")
    expect(chunks[0]!.path).toContain("Preferences")
  })

  it("creates a preamble chunk for content before first ##", () => {
    const md = `# Title

Some preamble content that is long enough to be a valid chunk.

## Section

Section content here.
`
    const chunks = chunkMarkdown(md, "test.md")
    expect(chunks).toHaveLength(2)
    // Preamble comes first
    expect(chunks[0]!.heading).toBeNull()
    expect(chunks[0]!.content).toContain("Some preamble content")
  })

  it("handles files with no ## headers (paragraph fallback)", () => {
    const md = `This is a simple file with enough content to pass the minimum chunk size threshold for testing.

Another paragraph here with sufficient content to be considered a separate chunk by the paragraph fallback logic.
`
    const chunks = chunkMarkdown(md, "simple.md")
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0]!.heading).toBeNull()
    expect(chunks[0]!.level).toBe(0)
  })

  it("discards chunks below MIN_CHUNK_SIZE (32 chars)", () => {
    const md = `## Tiny

ab

## Valid Section

This section has enough content to pass the minimum size threshold for chunking.
`
    const chunks = chunkMarkdown(md, "test.md")
    // "## Tiny\n\nab" is only ~14 chars, should be discarded
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.heading).toBe("## Valid Section")
  })

  it("generates deterministic UUIDv5 IDs", () => {
    const md = `## Section

Content here is long enough to be a valid chunk for testing purposes.
`
    const chunks1 = chunkMarkdown(md, "file.md")
    const chunks2 = chunkMarkdown(md, "file.md")
    expect(chunks1[0]!.id).toBe(chunks2[0]!.id)
  })

  it("produces different IDs for different files with same content", () => {
    const md = `## Section

Identical content in both files that is long enough for a valid chunk.
`
    const chunks1 = chunkMarkdown(md, "file-a.md")
    const chunks2 = chunkMarkdown(md, "file-b.md")
    expect(chunks1[0]!.id).not.toBe(chunks2[0]!.id)
  })

  it("generates SHA-256 content hashes", () => {
    const md = `## Section

Content for hash testing that is long enough to pass the minimum threshold.
`
    const chunks = chunkMarkdown(md, "test.md")
    expect(chunks[0]!.contentHash).toHaveLength(64)
    expect(chunks[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("includes ### subsections within their parent ## chunk", () => {
    const md = `## Deployment

Main deployment info is here for context.

### Docker

Docker deployment details go here with enough content.

### Kubernetes

K8s deployment details go here with enough content too.
`
    const chunks = chunkMarkdown(md, "test.md")
    // All content under ## Deployment should be one chunk
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toContain("Docker")
    expect(chunks[0]!.content).toContain("Kubernetes")
  })

  it("handles empty file", () => {
    expect(chunkMarkdown("", "empty.md")).toHaveLength(0)
  })

  it("handles file with only a title", () => {
    expect(chunkMarkdown("# Just a Title", "title.md")).toHaveLength(0)
  })

  it("splits oversized sections at paragraph boundaries", () => {
    const longParagraphs = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i}: ${"x".repeat(250)} end of paragraph ${i}.`,
    ).join("\n\n")

    const md = `## Big Section\n\n${longParagraphs}`
    const chunks = chunkMarkdown(md, "test.md")
    // With 20 * ~260 chars = ~5200 chars, exceeds 4096 → split into 2+ chunks
    expect(chunks.length).toBeGreaterThan(1)
    // Each sub-chunk should reference the heading
    for (const chunk of chunks) {
      expect(chunk.heading).toBe("## Big Section")
    }
  })

  it("sets level=2 for ## sections", () => {
    const md = `## Section\n\nContent that is long enough to pass the minimum chunk size for testing.`
    const chunks = chunkMarkdown(md, "test.md")
    expect(chunks[0]!.level).toBe(2)
  })
})
