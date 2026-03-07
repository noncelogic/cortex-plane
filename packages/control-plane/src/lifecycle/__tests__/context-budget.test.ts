import { describe, expect, it } from "vitest"

import {
  type BudgetResult,
  type ContextBudgetConfig,
  DEFAULT_CONTEXT_BUDGET,
  enforceContextBudget,
  type ExecutionContext,
  truncateComponent,
  validateContextBudget,
} from "../context-budget.js"

/** Safe accessor — asserts the component exists before returning it. */
function comp(result: BudgetResult, key: string) {
  const c = result.components[key]
  if (!c) throw new Error(`Missing component "${key}" in budget result`)
  return c
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

  it("returns content unchanged at exactly the limit", () => {
    const content = "a".repeat(50)
    const { result, truncated } = truncateComponent(content, 50)
    expect(result).toBe(content)
    expect(truncated).toBe(false)
  })

  it("truncates content exceeding the limit with marker", () => {
    const content = "a".repeat(100)
    const { result, truncated } = truncateComponent(content, 50)
    expect(truncated).toBe(true)
    expect(result.length).toBe(50)
    expect(result).toContain("[TRUNCATED]")
  })

  it("handles very small max (smaller than marker)", () => {
    const { result, truncated } = truncateComponent("hello world", 5)
    expect(truncated).toBe(true)
    expect(result.length).toBe(5)
  })

  it("preserves content before the truncation point", () => {
    const content = "ABCDEFGHIJ" + "x".repeat(100)
    const { result } = truncateComponent(content, 30)
    expect(result.startsWith("ABCDEFGHIJ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validateContextBudget
// ---------------------------------------------------------------------------

const makeContext = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  systemPrompt: "You are a helpful assistant.",
  identity: "Agent Alpha",
  memory: "Previous context here.",
  toolDefinitions: '{"tools":[]}',
  ...overrides,
})

describe("validateContextBudget", () => {
  it("accepts context within all budgets", () => {
    const result = validateContextBudget(makeContext())
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it("reports truncation for oversized system prompt", () => {
    const ctx = makeContext({ systemPrompt: "x".repeat(10_000) })
    const result = validateContextBudget(ctx)
    expect(comp(result, "systemPrompt").truncated).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("systemPrompt")
  })

  it("reports truncation for oversized identity", () => {
    const ctx = makeContext({ identity: "x".repeat(5_000) })
    const result = validateContextBudget(ctx)
    expect(comp(result, "identity").truncated).toBe(true)
    expect(result.warnings.some((w) => w.includes("identity"))).toBe(true)
  })

  it("reports truncation for oversized memory", () => {
    const ctx = makeContext({ memory: "x".repeat(5_000) })
    const result = validateContextBudget(ctx)
    expect(comp(result, "memory").truncated).toBe(true)
  })

  it("reports truncation for oversized tool definitions", () => {
    const ctx = makeContext({ toolDefinitions: "x".repeat(20_000) })
    const result = validateContextBudget(ctx)
    expect(comp(result, "toolDefinitions").truncated).toBe(true)
  })

  it("returns valid=false when total context exceeds maxTotalContextChars", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(8_000),
      identity: "x".repeat(4_000),
      memory: "x".repeat(4_000),
      toolDefinitions: "x".repeat(16_000),
      conversationHistory: "x".repeat(100_000),
    })
    const result = validateContextBudget(ctx)
    expect(result.valid).toBe(false)
    expect(result.warnings.some((w) => w.includes("Total context"))).toBe(true)
  })

  it("uses default config when none provided", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars + 1),
    })
    const result = validateContextBudget(ctx)
    expect(comp(result, "systemPrompt").truncated).toBe(true)
    expect(comp(result, "systemPrompt").max).toBe(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars)
  })

  it("respects custom config", () => {
    const customConfig: ContextBudgetConfig = {
      maxSystemPromptChars: 100,
      maxIdentityChars: 100,
      maxMemoryChars: 100,
      maxToolDefinitionsChars: 100,
      maxTotalContextChars: 1_000,
      reservedForConversation: 200,
    }
    const ctx = makeContext({ systemPrompt: "x".repeat(200) })
    const result = validateContextBudget(ctx, customConfig)
    expect(comp(result, "systemPrompt").truncated).toBe(true)
    expect(comp(result, "systemPrompt").max).toBe(100)
  })

  it("counts post-truncation sizes in totalChars", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(10_000), // will be capped at 8,000
      identity: "hello",
      memory: "world",
      toolDefinitions: "{}",
    })
    const result = validateContextBudget(ctx)
    // systemPrompt capped to 8000 + "hello"(5) + "world"(5) + "{}"(2) + conversation(0)
    expect(result.totalChars).toBe(8_000 + 5 + 5 + 2)
  })

  it("includes conversation history in total but does not truncate it", () => {
    const ctx = makeContext({ conversationHistory: "x".repeat(50_000) })
    const result = validateContextBudget(ctx)
    expect(comp(result, "conversationHistory").truncated).toBe(false)
    expect(comp(result, "conversationHistory").chars).toBe(50_000)
  })

  it("handles empty context", () => {
    const ctx: ExecutionContext = {
      systemPrompt: "",
      identity: "",
      memory: "",
      toolDefinitions: "",
    }
    const result = validateContextBudget(ctx)
    expect(result.valid).toBe(true)
    expect(result.totalChars).toBe(0)
  })

  it("handles missing conversationHistory", () => {
    const ctx = makeContext()
    delete ctx.conversationHistory
    const result = validateContextBudget(ctx)
    expect(comp(result, "conversationHistory").chars).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// enforceContextBudget
// ---------------------------------------------------------------------------

describe("enforceContextBudget", () => {
  it("returns context unchanged when within budget", () => {
    const ctx = makeContext()
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(budgetResult.warnings).toHaveLength(0)
    expect(enforcedContext.systemPrompt).toBe(ctx.systemPrompt)
    expect(enforcedContext.identity).toBe(ctx.identity)
    expect(enforcedContext.memory).toBe(ctx.memory)
    expect(enforcedContext.toolDefinitions).toBe(ctx.toolDefinitions)
  })

  it("truncates oversized system prompt and still passes total check", () => {
    const ctx = makeContext({ systemPrompt: "x".repeat(10_000) })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(comp(budgetResult, "systemPrompt").truncated).toBe(true)
    expect(enforcedContext.systemPrompt.length).toBe(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars)
    expect(enforcedContext.systemPrompt).toContain("[TRUNCATED]")
  })

  it("truncates oversized identity with marker, job still valid", () => {
    const ctx = makeContext({ identity: "x".repeat(6_000) })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(comp(budgetResult, "identity").truncated).toBe(true)
    expect(enforcedContext.identity.length).toBe(DEFAULT_CONTEXT_BUDGET.maxIdentityChars)
    expect(enforcedContext.identity).toContain("[TRUNCATED]")
  })

  it("truncates oversized memory", () => {
    const ctx = makeContext({ memory: "x".repeat(6_000) })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(comp(budgetResult, "memory").truncated).toBe(true)
    expect(enforcedContext.memory.length).toBe(DEFAULT_CONTEXT_BUDGET.maxMemoryChars)
    expect(enforcedContext.memory).toContain("[TRUNCATED]")
  })

  it("truncates oversized tool definitions", () => {
    const ctx = makeContext({ toolDefinitions: "x".repeat(20_000) })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(comp(budgetResult, "toolDefinitions").truncated).toBe(true)
    expect(enforcedContext.toolDefinitions.length).toBe(
      DEFAULT_CONTEXT_BUDGET.maxToolDefinitionsChars,
    )
    expect(enforcedContext.toolDefinitions).toContain("[TRUNCATED]")
  })

  it("returns valid=false when total exceeds budget even after per-component truncation", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(8_000),
      identity: "x".repeat(4_000),
      memory: "x".repeat(4_000),
      toolDefinitions: "x".repeat(16_000),
      conversationHistory: "x".repeat(100_000),
    })
    const { budgetResult } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(false)
    expect(budgetResult.warnings.some((w) => w.includes("Total context"))).toBe(true)
  })

  it("does not mutate the original context", () => {
    const ctx = makeContext({ systemPrompt: "x".repeat(10_000) })
    const original = ctx.systemPrompt
    enforceContextBudget(ctx)
    expect(ctx.systemPrompt).toBe(original)
  })

  it("never truncates conversation history", () => {
    const history = "x".repeat(50_000)
    const ctx = makeContext({ conversationHistory: history })
    const { enforcedContext } = enforceContextBudget(ctx)
    expect(enforcedContext.conversationHistory).toBe(history)
  })

  it("uses custom config for enforcement", () => {
    const config: ContextBudgetConfig = {
      maxSystemPromptChars: 50,
      maxIdentityChars: 50,
      maxMemoryChars: 50,
      maxToolDefinitionsChars: 50,
      maxTotalContextChars: 500,
      reservedForConversation: 100,
    }
    const ctx = makeContext({ systemPrompt: "x".repeat(200) })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx, config)
    expect(comp(budgetResult, "systemPrompt").truncated).toBe(true)
    expect(enforcedContext.systemPrompt.length).toBe(50)
  })

  it("truncates multiple components independently", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(10_000),
      identity: "x".repeat(6_000),
      memory: "x".repeat(6_000),
    })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(budgetResult.valid).toBe(true)
    expect(comp(budgetResult, "systemPrompt").truncated).toBe(true)
    expect(comp(budgetResult, "identity").truncated).toBe(true)
    expect(comp(budgetResult, "memory").truncated).toBe(true)
    expect(enforcedContext.systemPrompt.length).toBe(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars)
    expect(enforcedContext.identity.length).toBe(DEFAULT_CONTEXT_BUDGET.maxIdentityChars)
    expect(enforcedContext.memory.length).toBe(DEFAULT_CONTEXT_BUDGET.maxMemoryChars)
  })

  it("applies system defaults when no config provided", () => {
    const ctx = makeContext({
      systemPrompt: "x".repeat(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars + 100),
    })
    const { budgetResult, enforcedContext } = enforceContextBudget(ctx)
    expect(comp(budgetResult, "systemPrompt").truncated).toBe(true)
    expect(enforcedContext.systemPrompt.length).toBe(DEFAULT_CONTEXT_BUDGET.maxSystemPromptChars)
  })
})
