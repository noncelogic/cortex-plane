import { describe, expect, it } from "vitest"

import { hashContent, parseFrontmatter, parseSkillMd } from "../skills/loader.js"

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses string values", () => {
    const fm = parseFrontmatter("title: Code Review\nsummary: Reviews code quality")
    expect(fm.title).toBe("Code Review")
    expect(fm.summary).toBe("Reviews code quality")
  })

  it("parses boolean values", () => {
    const fm = parseFrontmatter("networkAccess: false\nshellAccess: true")
    expect(fm.networkAccess).toBe(false)
    expect(fm.shellAccess).toBe(true)
  })

  it("parses inline arrays", () => {
    const fm = parseFrontmatter("tags: [review, quality, security]")
    expect(fm.tags).toEqual(["review", "quality", "security"])
  })

  it("parses empty arrays", () => {
    const fm = parseFrontmatter("allowedTools: []")
    expect(fm.allowedTools).toEqual([])
  })

  it("ignores comments and blank lines", () => {
    const fm = parseFrontmatter("# Comment\n\ntitle: Test\n# Another comment")
    expect(fm.title).toBe("Test")
  })

  it("handles quoted strings", () => {
    const fm = parseFrontmatter("title: \"My Skill\"\nsummary: 'Handles things'")
    expect(fm.title).toBe("My Skill")
    expect(fm.summary).toBe("Handles things")
  })

  it("handles values with colons", () => {
    const fm = parseFrontmatter("summary: Step 1: do things")
    expect(fm.summary).toBe("Step 1: do things")
  })
})

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns a 64-char hex SHA-256 hash", () => {
    const hash = hashContent("hello world")
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("returns different hashes for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"))
  })

  it("returns same hash for same content", () => {
    expect(hashContent("test")).toBe(hashContent("test"))
  })
})

// ---------------------------------------------------------------------------
// parseSkillMd
// ---------------------------------------------------------------------------

describe("parseSkillMd", () => {
  const SKILL_MD = `---
title: Code Review
tags: [review, quality]
summary: Reviews code for quality and correctness
allowedTools: [Read, Grep, Glob]
deniedTools: [Write, Bash]
networkAccess: false
shellAccess: false
---
# Code Review Skill

Review all code changes for:
- Security vulnerabilities
- Performance issues
`

  it("extracts metadata from frontmatter", () => {
    const { metadata } = parseSkillMd(SKILL_MD, "/workspace/skills/code-review/SKILL.md", 1000)
    expect(metadata.name).toBe("code-review")
    expect(metadata.title).toBe("Code Review")
    expect(metadata.tags).toEqual(["review", "quality"])
    expect(metadata.summary).toBe("Reviews code for quality and correctness")
  })

  it("extracts constraints from frontmatter", () => {
    const { metadata } = parseSkillMd(SKILL_MD, "/workspace/skills/code-review/SKILL.md", 1000)
    expect(metadata.constraints.allowedTools).toEqual(["Read", "Grep", "Glob"])
    expect(metadata.constraints.deniedTools).toEqual(["Write", "Bash"])
    expect(metadata.constraints.networkAccess).toBe(false)
    expect(metadata.constraints.shellAccess).toBe(false)
  })

  it("extracts body content without frontmatter", () => {
    const { content } = parseSkillMd(SKILL_MD, "/workspace/skills/code-review/SKILL.md", 1000)
    expect(content).toContain("# Code Review Skill")
    expect(content).toContain("Security vulnerabilities")
    expect(content).not.toContain("---")
    expect(content).not.toContain("tags:")
  })

  it("computes content hash", () => {
    const { metadata } = parseSkillMd(SKILL_MD, "/workspace/skills/code-review/SKILL.md", 1000)
    expect(metadata.contentHash).toHaveLength(64)
  })

  it("records mtime and filePath", () => {
    const { metadata } = parseSkillMd(SKILL_MD, "/workspace/skills/code-review/SKILL.md", 12345)
    expect(metadata.mtimeMs).toBe(12345)
    expect(metadata.filePath).toBe("/workspace/skills/code-review/SKILL.md")
  })

  it("derives skill name from parent directory", () => {
    const { metadata } = parseSkillMd(SKILL_MD, "/ws/skills/my-skill/SKILL.md", 1000)
    expect(metadata.name).toBe("my-skill")
  })

  it("handles SKILL.md without frontmatter", () => {
    const raw = "# Just Instructions\n\nDo the thing."
    const { metadata, content } = parseSkillMd(raw, "/ws/skills/basic/SKILL.md", 1000)
    expect(metadata.name).toBe("basic")
    expect(metadata.title).toBe("basic")
    expect(metadata.tags).toEqual([])
    expect(metadata.constraints.allowedTools).toEqual([])
    expect(content).toBe(raw)
  })

  it("handles minimal frontmatter", () => {
    const raw = "---\ntitle: Minimal\n---\nContent here."
    const { metadata, content } = parseSkillMd(raw, "/ws/skills/min/SKILL.md", 1000)
    expect(metadata.title).toBe("Minimal")
    expect(metadata.tags).toEqual([])
    expect(metadata.summary).toBe("")
    expect(content).toBe("Content here.")
  })
})
