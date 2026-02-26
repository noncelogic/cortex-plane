import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SkillIndex } from "../skills/skill-index.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const REVIEW_SKILL = `---
title: Code Review
tags: [review, quality]
summary: Reviews code for quality and correctness
allowedTools: [Read, Grep, Glob]
deniedTools: [Write, Bash]
networkAccess: false
shellAccess: false
---
# Code Review Skill

Review all code changes carefully.
`

const SHELL_SKILL = `---
title: Shell Operations
tags: [shell, ops]
summary: Executes shell commands safely
allowedTools: [Bash, Read]
deniedTools: []
networkAccess: false
shellAccess: true
---
# Shell Operations

Run commands in a sandboxed environment.
`

const RESEARCH_SKILL = `---
title: Research
tags: [research, quality]
summary: Gathers information from code and docs
allowedTools: [Read, Grep, Glob, WebFetch]
deniedTools: [Write, Edit, Bash]
networkAccess: true
shellAccess: false
---
# Research Skill

Analyze code and documentation to answer questions.
`

let testDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `skill-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

async function writeSkill(name: string, content: string): Promise<void> {
  const dir = join(testDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), content)
}

// ---------------------------------------------------------------------------
// SkillIndex
// ---------------------------------------------------------------------------

describe("SkillIndex", () => {
  it("initializes empty when skills directory does not exist", async () => {
    const index = new SkillIndex("/nonexistent/path")
    await index.refresh()
    expect(index.size).toBe(0)
    expect(index.isInitialized).toBe(true)
  })

  it("indexes SKILL.md files from subdirectories", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    await writeSkill("shell-ops", SHELL_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    expect(index.size).toBe(2)
    expect(index.getByName("code-review")).toBeDefined()
    expect(index.getByName("shell-ops")).toBeDefined()
  })

  it("extracts correct metadata", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const meta = index.getByName("code-review")!
    expect(meta.title).toBe("Code Review")
    expect(meta.tags).toEqual(["review", "quality"])
    expect(meta.summary).toBe("Reviews code for quality and correctness")
    expect(meta.constraints.allowedTools).toEqual(["Read", "Grep", "Glob"])
    expect(meta.constraints.deniedTools).toEqual(["Write", "Bash"])
    expect(meta.constraints.networkAccess).toBe(false)
    expect(meta.constraints.shellAccess).toBe(false)
  })

  it("getAll returns all indexed skills", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    await writeSkill("shell-ops", SHELL_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const all = index.getAll()
    expect(all).toHaveLength(2)
    expect(all.map((s) => s.name).sort()).toEqual(["code-review", "shell-ops"])
  })

  it("getByTags returns skills matching any tag", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    await writeSkill("shell-ops", SHELL_SKILL)
    await writeSkill("research", RESEARCH_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const qualitySkills = index.getByTags(["quality"])
    expect(qualitySkills.map((s) => s.name).sort()).toEqual(["code-review", "research"])

    const shellSkills = index.getByTags(["shell"])
    expect(shellSkills.map((s) => s.name)).toEqual(["shell-ops"])
  })

  it("getByTags returns empty for unmatched tags", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    expect(index.getByTags(["nonexistent"])).toEqual([])
  })

  it("resolve loads full content for requested skills", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    await writeSkill("shell-ops", SHELL_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const resolved = await index.resolve(["code-review"])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.metadata.name).toBe("code-review")
    expect(resolved[0]!.content).toContain("Review all code changes carefully.")
  })

  it("resolve skips unknown skill names", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const resolved = await index.resolve(["code-review", "nonexistent"])
    expect(resolved).toHaveLength(1)
  })

  it("detects new skills on refresh", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()
    expect(index.size).toBe(1)

    // Add a new skill
    await writeSkill("shell-ops", SHELL_SKILL)
    await index.refresh()
    expect(index.size).toBe(2)
  })

  it("detects deleted skills on refresh", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    await writeSkill("shell-ops", SHELL_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()
    expect(index.size).toBe(2)

    // Remove a skill
    await rm(join(testDir, "shell-ops"), { recursive: true })
    await index.refresh()
    expect(index.size).toBe(1)
    expect(index.getByName("shell-ops")).toBeUndefined()
  })

  it("invalidate forces re-read on next refresh", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()

    const hashBefore = index.getByName("code-review")!.contentHash

    // Update the file content
    const updatedContent = REVIEW_SKILL.replace(
      "Review all code changes carefully.",
      "Updated instructions.",
    )
    await writeSkill("code-review", updatedContent)

    // Without invalidate, mtime might match (depending on filesystem resolution)
    index.invalidate("code-review")
    await index.refresh()

    const hashAfter = index.getByName("code-review")!.contentHash
    expect(hashAfter).not.toBe(hashBefore)
  })

  it("clear resets the index", async () => {
    await writeSkill("code-review", REVIEW_SKILL)

    const index = new SkillIndex(testDir)
    await index.refresh()
    expect(index.size).toBe(1)
    expect(index.isInitialized).toBe(true)

    index.clear()
    expect(index.size).toBe(0)
    expect(index.isInitialized).toBe(false)
  })

  it("ignores directories without SKILL.md", async () => {
    await writeSkill("code-review", REVIEW_SKILL)
    // Create a directory without SKILL.md
    await mkdir(join(testDir, "empty-dir"), { recursive: true })

    const index = new SkillIndex(testDir)
    await index.refresh()
    expect(index.size).toBe(1)
  })
})
