import { describe, expect, it } from "vitest"

import {
  estimateContentTokens,
  estimateTokens,
  formatSkillInstructions,
  formatSkillSummaries,
  selectWithinBudget,
} from "../skills/budget.js"
import type { SkillDefinition, SkillMetadata } from "../skills/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    title: "Test Skill",
    tags: ["test"],
    summary: "A test skill",
    constraints: {
      allowedTools: [],
      deniedTools: [],
      networkAccess: false,
      shellAccess: true,
    },
    contentHash: "abc123",
    mtimeMs: Date.now(),
    filePath: "/workspace/skills/test-skill/SKILL.md",
    ...overrides,
  }
}

function makeDefinition(content: string, meta?: Partial<SkillMetadata>): SkillDefinition {
  return {
    metadata: makeMetadata(meta),
    content,
  }
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    // 100 chars → 25 tokens
    expect(estimateTokens("a".repeat(100))).toBe(25)
  })

  it("rounds up partial tokens", () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens("hello")).toBe(2)
  })

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// estimateContentTokens
// ---------------------------------------------------------------------------

describe("estimateContentTokens", () => {
  it("sums token estimates across skills", () => {
    const skills = [
      makeDefinition("a".repeat(100)), // 25 tokens
      makeDefinition("b".repeat(200)), // 50 tokens
    ]
    expect(estimateContentTokens(skills)).toBe(75)
  })

  it("returns 0 for empty array", () => {
    expect(estimateContentTokens([])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// selectWithinBudget
// ---------------------------------------------------------------------------

describe("selectWithinBudget", () => {
  it("selects skills that fit within budget", () => {
    const skills = [
      makeDefinition("a".repeat(400), { name: "small" }), // 100 tokens
      makeDefinition("b".repeat(400), { name: "medium" }), // 100 tokens
      makeDefinition("c".repeat(4000), { name: "large" }), // 1000 tokens
    ]

    const selected = selectWithinBudget(skills, 250)
    expect(selected).toHaveLength(2)
    expect(selected[0]!.metadata.name).toBe("small")
    expect(selected[1]!.metadata.name).toBe("medium")
  })

  it("respects priority order (first = highest priority)", () => {
    const skills = [
      makeDefinition("a".repeat(4000), { name: "priority-1" }), // 1000 tokens
      makeDefinition("b".repeat(400), { name: "priority-2" }), // 100 tokens
    ]

    const selected = selectWithinBudget(skills, 1000)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.metadata.name).toBe("priority-1")
  })

  it("returns empty array when no skills fit", () => {
    const skills = [makeDefinition("a".repeat(4000))]
    expect(selectWithinBudget(skills, 10)).toEqual([])
  })

  it("returns all skills when budget is large enough", () => {
    const skills = [makeDefinition("a".repeat(100)), makeDefinition("b".repeat(100))]
    expect(selectWithinBudget(skills, 100_000)).toHaveLength(2)
  })

  it("skips skills that don't fit but continues checking smaller ones", () => {
    const skills = [
      makeDefinition("a".repeat(400), { name: "small-1" }), // 100 tokens
      makeDefinition("b".repeat(4000), { name: "too-big" }), // 1000 tokens
      makeDefinition("c".repeat(400), { name: "small-2" }), // 100 tokens
    ]

    // Budget of 250: small-1 (100) fits, too-big (1000) doesn't, small-2 (100) fits
    const selected = selectWithinBudget(skills, 250)
    expect(selected).toHaveLength(2)
    expect(selected.map((s) => s.metadata.name)).toEqual(["small-1", "small-2"])
  })
})

// ---------------------------------------------------------------------------
// formatSkillSummaries
// ---------------------------------------------------------------------------

describe("formatSkillSummaries", () => {
  it("formats summaries as markdown list", () => {
    const skills = [
      makeMetadata({ title: "Code Review", tags: ["review"], summary: "Reviews code" }),
      makeMetadata({ title: "Shell Ops", tags: ["shell", "ops"], summary: "Runs commands" }),
    ]
    const result = formatSkillSummaries(skills)
    expect(result).toContain("Available skills:")
    expect(result).toContain("**Code Review** [review]: Reviews code")
    expect(result).toContain("**Shell Ops** [shell, ops]: Runs commands")
  })

  it("returns empty string for no skills", () => {
    expect(formatSkillSummaries([])).toBe("")
  })
})

// ---------------------------------------------------------------------------
// formatSkillInstructions
// ---------------------------------------------------------------------------

describe("formatSkillInstructions", () => {
  it("formats selected skill content with headers", () => {
    const skills = [
      makeDefinition("Do code review.\n", { title: "Code Review" }),
      makeDefinition("Run shell commands.\n", { title: "Shell Ops" }),
    ]
    const result = formatSkillInstructions(skills)
    expect(result).toContain("## Skill: Code Review")
    expect(result).toContain("Do code review.")
    expect(result).toContain("## Skill: Shell Ops")
    expect(result).toContain("Run shell commands.")
  })

  it("returns empty string for no skills", () => {
    expect(formatSkillInstructions([])).toBe("")
  })
})
