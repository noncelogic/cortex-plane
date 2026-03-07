import { describe, expect, it, vi } from "vitest"

import { echoTool } from "../../backends/tool-executor.js"
import type { CapabilityAssembler } from "../assembler.js"
import { narrowDataScope, validateDelegation } from "../delegation.js"
import type { EffectiveTool } from "../types.js"

// ── Helpers ──

function makeEffectiveTool(overrides: Partial<EffectiveTool> = {}): EffectiveTool {
  return {
    toolRef: "tool_a",
    bindingId: "binding-a",
    approvalPolicy: "auto",
    toolDefinition: echoTool,
    ...overrides,
  }
}

function mockAssembler(parentTools: EffectiveTool[]): CapabilityAssembler {
  return {
    resolveEffectiveTools: vi.fn().mockResolvedValue(parentTools),
  } as unknown as CapabilityAssembler
}

const mockDb = {} as never

// ── validateDelegation ──

describe("validateDelegation", () => {
  it("parent with [A,B,C] delegating [A,B,D] → subagent gets [A,B], D denied", async () => {
    const parentTools = [
      makeEffectiveTool({ toolRef: "tool_a", bindingId: "b-a" }),
      makeEffectiveTool({ toolRef: "tool_b", bindingId: "b-b" }),
      makeEffectiveTool({ toolRef: "tool_c", bindingId: "b-c" }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: ["tool_a", "tool_b", "tool_d"] },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toHaveLength(2)
    expect(result.effectiveTools.map((t) => t.toolRef)).toEqual(["tool_a", "tool_b"])
    expect(result.denied).toEqual(["tool_d"])
  })

  it("parent with always_approve on tool A → subagent inherits always_approve", async () => {
    const parentTools = [
      makeEffectiveTool({
        toolRef: "tool_a",
        approvalPolicy: "always_approve",
      }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: ["tool_a"] },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toHaveLength(1)
    expect(result.effectiveTools[0]!.approvalPolicy).toBe("always_approve")
  })

  it("rate limits are shared: subagent tool references parent's binding", async () => {
    const rateLimit = { maxCalls: 3, windowSeconds: 60 }
    const parentTools = [
      makeEffectiveTool({
        toolRef: "tool_a",
        bindingId: "parent-binding-a",
        rateLimit,
      }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: ["tool_a"] },
      { db: mockDb, assembler },
    )

    // Subagent's effective tool keeps the parent's bindingId and rateLimit,
    // so CapabilityGuard queries the same audit log rows → shared window.
    expect(result.effectiveTools[0]!.bindingId).toBe("parent-binding-a")
    expect(result.effectiveTools[0]!.rateLimit).toEqual(rateLimit)
  })

  it("delegation with narrowed data_scope succeeds", async () => {
    const parentTools = [
      makeEffectiveTool({
        toolRef: "calendar_read",
        dataScope: { calendars: ["primary", "team"] },
      }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      {
        agentId: "sub-agent",
        delegatedTools: ["calendar_read"],
        dataScopes: { calendar_read: { calendars: ["primary"] } },
      },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toHaveLength(1)
    expect(result.effectiveTools[0]!.dataScope).toEqual({ calendars: ["primary"] })
    expect(result.warnings).toHaveLength(0)
  })

  it("delegation with widened data_scope → parent scope used, warning logged", async () => {
    const parentTools = [
      makeEffectiveTool({
        toolRef: "calendar_read",
        dataScope: { calendars: ["primary", "team"] },
      }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      {
        agentId: "sub-agent",
        delegatedTools: ["calendar_read"],
        dataScopes: { calendar_read: { calendars: ["primary", "personal"] } },
      },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toHaveLength(1)
    // "personal" is not in parent scope → dropped
    expect(result.effectiveTools[0]!.dataScope).toEqual({ calendars: ["primary"] })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("personal")
  })

  it("empty delegation → subagent gets zero tools", async () => {
    const parentTools = [makeEffectiveTool({ toolRef: "tool_a" })]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: [] },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toEqual([])
    expect(result.denied).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("preserves costBudget and approvalCondition from parent", async () => {
    const parentTools = [
      makeEffectiveTool({
        toolRef: "tool_a",
        approvalPolicy: "conditional",
        approvalCondition: { maxAmount: 100 },
        costBudget: { maxUsd: 5, windowSeconds: 3600 },
      }),
    ]
    const assembler = mockAssembler(parentTools)

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: ["tool_a"] },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools[0]!.approvalCondition).toEqual({ maxAmount: 100 })
    expect(result.effectiveTools[0]!.costBudget).toEqual({ maxUsd: 5, windowSeconds: 3600 })
  })

  it("all delegated tools denied when parent has no tools", async () => {
    const assembler = mockAssembler([])

    const result = await validateDelegation(
      "parent-agent",
      { agentId: "sub-agent", delegatedTools: ["tool_a", "tool_b"] },
      { db: mockDb, assembler },
    )

    expect(result.effectiveTools).toEqual([])
    expect(result.denied).toEqual(["tool_a", "tool_b"])
  })
})

// ── narrowDataScope ──

describe("narrowDataScope", () => {
  it("returns undefined when parent has no scope", () => {
    const warnings: string[] = []
    const result = narrowDataScope(undefined, { calendars: ["primary"] }, "tool", warnings)
    expect(result).toBeUndefined()
  })

  it("intersects array values", () => {
    const warnings: string[] = []
    const result = narrowDataScope(
      { calendars: ["primary", "team", "shared"] },
      { calendars: ["primary", "team"] },
      "tool",
      warnings,
    )
    expect(result).toEqual({ calendars: ["primary", "team"] })
    expect(warnings).toHaveLength(0)
  })

  it("drops values outside parent scope with warning", () => {
    const warnings: string[] = []
    const result = narrowDataScope(
      { calendars: ["primary", "team"] },
      { calendars: ["primary", "personal"] },
      "calendar_read",
      warnings,
    )
    expect(result).toEqual({ calendars: ["primary"] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("personal")
    expect(warnings[0]).toContain("calendar_read")
  })

  it("warns when requested scope key not in parent", () => {
    const warnings: string[] = []
    const result = narrowDataScope(
      { calendars: ["primary"] },
      { repos: ["my-repo"] },
      "tool",
      warnings,
    )
    // Unknown key dropped, parent keys carried forward
    expect(result).toEqual({ calendars: ["primary"] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("repos")
  })

  it("uses parent value for non-array scope that differs", () => {
    const warnings: string[] = []
    const result = narrowDataScope({ readOnly: true }, { readOnly: false }, "tool", warnings)
    expect(result).toEqual({ readOnly: true })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("cannot be widened")
  })

  it("carries forward parent scope keys not in request", () => {
    const warnings: string[] = []
    const result = narrowDataScope(
      { calendars: ["primary", "team"], readOnly: true },
      { calendars: ["primary"] },
      "tool",
      warnings,
    )
    expect(result).toEqual({ calendars: ["primary"], readOnly: true })
  })
})
