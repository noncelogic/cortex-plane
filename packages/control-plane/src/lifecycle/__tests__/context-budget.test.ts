import { describe, expect, it } from "vitest"

import {
  truncateComponent,
  validateContextBudget,
  type ContextBudgetConfig,
  type ContextComponents,
} from "../context-budget.js"
import { DEFAULT_CONTEXT_BUDGET } from "../defaults.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig {
  return { ...DEFAULT_CONTEXT_BUDGET, ...overrides }
}

function makeContext(overrides: Partial<ContextComponents> = {}): ContextComponents {
  return {
    systemPrompt: "You are a helpful agent.",
    identity: "Agent Alpha, software engineer.",
    memories: "Remember: use TypeScript.",
    toolDefinitions: '{"name":"bash"}',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// truncateComponent
// ---------------------------------------------------------------------------

describe("truncateComponent", () => {
  it("returns content unchanged when within budget", () => {
    const { result, truncated } = truncateComponent("hello", 100)
    expect(result).toBe("hello")
    expect(truncated).toBe(false)
  })

  it("returns content unchanged when exactly at budget", () => {
    const { result, truncated } = truncateComponent("12345", 5)
    expect(result).toBe("12345")
    expect(truncated).toBe(false)
  })

  it("truncates with [TRUNCATED] marker when over budget", () => {
    const content = "a".repeat(200)
    const { result, truncated } = truncateComponent(content, 100)

    expect(truncated).toBe(true)
    expect(result).toHaveLength(100)
    expect(result.endsWith("[TRUNCATED]")).toBe(true)
  })

  it("handles maxChars smaller than marker length", () => {
    const { result, truncated } = truncateComponent("some long content", 5)
    expect(truncated).toBe(true)
    expect(result).toHaveLength(5)
    // Should be a prefix of the marker itself
    expect(result).toBe("[TRUN")
  })

  it("handles empty content", () => {
    const { result, truncated } = truncateComponent("", 100)
    expect(result).toBe("")
    expect(truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateContextBudget
// ---------------------------------------------------------------------------

describe("validateContextBudget", () => {
  it("returns valid=true when all components are within budget", () => {
    const context = makeContext()
    const config = makeConfig()
    const result = validateContextBudget(context, config)

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)

    // No component should be truncated
    for (const comp of Object.values(result.components)) {
      expect(comp.truncated).toBe(false)
    }
  })

  it("flags system prompt exceeding its max", () => {
    const context = makeContext({
      systemPrompt: "x".repeat(10_000),
    })
    const config = makeConfig({ maxSystemPromptChars: 8_000 })
    const result = validateContextBudget(context, config)

    expect(result.components["systemPrompt"]!.truncated).toBe(true)
    expect(result.components["systemPrompt"]!.chars).toBe(10_000)
    expect(result.components["systemPrompt"]!.max).toBe(8_000)
    expect(result.warnings.some((w) => w.includes("systemPrompt"))).toBe(true)
  })

  it("flags identity exceeding its max", () => {
    const context = makeContext({
      identity: "y".repeat(5_000),
    })
    const config = makeConfig({ maxIdentityChars: 4_000 })
    const result = validateContextBudget(context, config)

    expect(result.components["identity"]!.truncated).toBe(true)
    expect(result.warnings.some((w) => w.includes("identity"))).toBe(true)
  })

  it("flags memories exceeding their max", () => {
    const context = makeContext({
      memories: "m".repeat(6_000),
    })
    const config = makeConfig({ maxMemoryChars: 4_000 })
    const result = validateContextBudget(context, config)

    expect(result.components["memories"]!.truncated).toBe(true)
  })

  it("flags tool definitions exceeding their max", () => {
    const context = makeContext({
      toolDefinitions: "t".repeat(20_000),
    })
    const config = makeConfig({ maxToolDefinitionsChars: 16_000 })
    const result = validateContextBudget(context, config)

    expect(result.components["toolDefinitions"]!.truncated).toBe(true)
  })

  it("returns valid=false when total context exceeds budget", () => {
    // Create context that fits individual limits but exceeds total
    const config = makeConfig({
      maxSystemPromptChars: 50_000,
      maxIdentityChars: 50_000,
      maxMemoryChars: 50_000,
      maxToolDefinitionsChars: 50_000,
      maxTotalContextChars: 120_000,
      reservedForConversation: 40_000,
    })

    const context = makeContext({
      systemPrompt: "s".repeat(30_000),
      identity: "i".repeat(25_000),
      memories: "m".repeat(15_000),
      toolDefinitions: "t".repeat(15_000),
    })

    const result = validateContextBudget(context, config)

    // 30k+25k+15k+15k = 85k > 80k (120k - 40k reserved)
    expect(result.valid).toBe(false)
    expect(result.totalChars).toBe(85_000)
    expect(result.warnings.some((w) => w.includes("Total context"))).toBe(true)
  })

  it("applies system defaults when no contextBudget config on agent", () => {
    // Using DEFAULT_CONTEXT_BUDGET directly
    const context = makeContext()
    const result = validateContextBudget(context, DEFAULT_CONTEXT_BUDGET)

    expect(result.valid).toBe(true)
    expect(result.components["systemPrompt"]!.max).toBe(8_000)
    expect(result.components["identity"]!.max).toBe(4_000)
    expect(result.components["memories"]!.max).toBe(4_000)
    expect(result.components["toolDefinitions"]!.max).toBe(16_000)
  })

  it("handles missing context components gracefully", () => {
    const result = validateContextBudget({}, makeConfig())

    expect(result.valid).toBe(true)
    expect(result.totalChars).toBe(0)
    expect(result.components["systemPrompt"]!.chars).toBe(0)
    expect(result.components["identity"]!.chars).toBe(0)
    expect(result.components["memories"]!.chars).toBe(0)
    expect(result.components["toolDefinitions"]!.chars).toBe(0)
  })

  it("reports correct totalChars", () => {
    const context = makeContext({
      systemPrompt: "abc",
      identity: "de",
      memories: "f",
      toolDefinitions: "gh",
    })
    const result = validateContextBudget(context, makeConfig())

    expect(result.totalChars).toBe(8) // 3 + 2 + 1 + 2
  })

  it("integration: oversized identity gets truncated and job still runs", () => {
    const oversizedIdentity = "x".repeat(6_000)
    const config = makeConfig({ maxIdentityChars: 4_000 })

    const context = makeContext({ identity: oversizedIdentity })
    const budgetResult = validateContextBudget(context, config)

    // Identity is flagged
    expect(budgetResult.components["identity"]!.truncated).toBe(true)

    // Apply truncation
    const { result: truncatedIdentity } = truncateComponent(
      oversizedIdentity,
      config.maxIdentityChars,
    )

    expect(truncatedIdentity.length).toBeLessThanOrEqual(config.maxIdentityChars)
    expect(truncatedIdentity.endsWith("[TRUNCATED]")).toBe(true)

    // Re-validate with truncated identity — total should now be valid
    const revalidated = validateContextBudget({ ...context, identity: truncatedIdentity }, config)
    expect(revalidated.valid).toBe(true)
    expect(revalidated.components["identity"]!.truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_CONTEXT_BUDGET
// ---------------------------------------------------------------------------

describe("DEFAULT_CONTEXT_BUDGET", () => {
  it("has expected default values", () => {
    expect(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars).toBe(8_000)
    expect(DEFAULT_CONTEXT_BUDGET.maxIdentityChars).toBe(4_000)
    expect(DEFAULT_CONTEXT_BUDGET.maxMemoryChars).toBe(4_000)
    expect(DEFAULT_CONTEXT_BUDGET.maxToolDefinitionsChars).toBe(16_000)
    expect(DEFAULT_CONTEXT_BUDGET.maxTotalContextChars).toBe(120_000)
    expect(DEFAULT_CONTEXT_BUDGET.reservedForConversation).toBe(40_000)
  })
})
