import { describe, expect, it, vi } from "vitest"

import type { ApprovalService } from "../../approval/service.js"
import type { ToolDefinition } from "../../backends/tool-executor.js"
import { CapabilityGuard, evaluateCondition } from "../guard.js"
import type { EffectiveTool } from "../types.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeFakeExecute(result = "ok") {
  return vi.fn<(input: Record<string, unknown>) => Promise<string>>().mockResolvedValue(result)
}

function makeToolDef(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test-tool",
    description: "A test tool",
    inputSchema: {},
    execute: makeFakeExecute(),
    ...overrides,
  }
}

function makeEffectiveTool(overrides: Partial<EffectiveTool> = {}): EffectiveTool {
  return {
    toolRef: "mcp:server:test-tool",
    bindingId: "binding-1",
    approvalPolicy: "auto",
    source: { kind: "mcp" },
    toolDefinition: makeToolDef(),
    ...overrides,
  }
}

const CTX = { agentId: "agent-1", jobId: "job-1", userId: "user-1" }

/** Tracks audit inserts so we can assert on them. */
function mockDb(auditCount = 0) {
  const insertedRows: Record<string, unknown>[] = []
  return {
    db: {
      selectFrom: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue({ count: auditCount }),
                }),
              }),
            }),
          }),
        }),
      }),
      insertInto: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          insertedRows.push(row)
          return { execute: vi.fn().mockResolvedValue([]) }
        }),
      }),
      fn: {
        countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue("count") }),
      },
    } as never,
    insertedRows,
  }
}

function mockApprovalService(approvalRequestId = "approval-123"): ApprovalService {
  return {
    createRequest: vi.fn().mockResolvedValue({
      approvalRequestId,
      plaintextToken: "tok_test",
      expiresAt: new Date(),
      riskLevel: "P2",
      autoApprovable: false,
      shouldNotify: true,
    }),
  } as unknown as ApprovalService
}

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  it("equals — true when field matches value", () => {
    expect(
      evaluateCondition(
        { field: "action", operator: "equals", value: "delete" },
        { action: "delete" },
      ),
    ).toBe(true)
  })

  it("equals — false when field does not match", () => {
    expect(
      evaluateCondition(
        { field: "action", operator: "equals", value: "delete" },
        { action: "read" },
      ),
    ).toBe(false)
  })

  it("not_equals — true when field differs", () => {
    expect(
      evaluateCondition(
        { field: "action", operator: "not_equals", value: "delete" },
        { action: "read" },
      ),
    ).toBe(true)
  })

  it("not_equals — false when field matches", () => {
    expect(
      evaluateCondition(
        { field: "action", operator: "not_equals", value: "delete" },
        { action: "delete" },
      ),
    ).toBe(false)
  })

  it("matches — glob pattern", () => {
    expect(
      evaluateCondition(
        { field: "path", operator: "matches", value: "/admin/*" },
        { path: "/admin/users" },
      ),
    ).toBe(true)
  })

  it("matches — returns false for non-matching glob", () => {
    expect(
      evaluateCondition(
        { field: "path", operator: "matches", value: "/admin/*" },
        { path: "/public/docs" },
      ),
    ).toBe(false)
  })

  it("not_matches — true when glob does not match", () => {
    expect(
      evaluateCondition(
        { field: "path", operator: "not_matches", value: "/admin/*" },
        { path: "/public/docs" },
      ),
    ).toBe(true)
  })

  it("not_matches — false when glob matches", () => {
    expect(
      evaluateCondition(
        { field: "path", operator: "not_matches", value: "/admin/*" },
        { path: "/admin/x" },
      ),
    ).toBe(false)
  })

  it("in — true when value is in array", () => {
    expect(
      evaluateCondition(
        { field: "env", operator: "in", value: ["prod", "staging"] },
        { env: "prod" },
      ),
    ).toBe(true)
  })

  it("in — false when value is not in array", () => {
    expect(
      evaluateCondition(
        { field: "env", operator: "in", value: ["prod", "staging"] },
        { env: "dev" },
      ),
    ).toBe(false)
  })

  it("not_in — true when value is not in array", () => {
    expect(
      evaluateCondition({ field: "env", operator: "not_in", value: ["prod"] }, { env: "dev" }),
    ).toBe(true)
  })

  it("not_in — false when value is in array", () => {
    expect(
      evaluateCondition({ field: "env", operator: "not_in", value: ["prod"] }, { env: "prod" }),
    ).toBe(false)
  })

  it("unknown operator returns false", () => {
    expect(evaluateCondition({ field: "x", operator: "regex", value: ".*" }, { x: "abc" })).toBe(
      false,
    )
  })

  it("matches returns false for non-string field values", () => {
    expect(evaluateCondition({ field: "num", operator: "matches", value: "*" }, { num: 42 })).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// CapabilityGuard.wrap — rate limiting
// ---------------------------------------------------------------------------

describe("CapabilityGuard.wrap — rate limiting", () => {
  it("allows calls within the rate limit", async () => {
    const execute = makeFakeExecute("result")
    const tool = makeEffectiveTool({
      rateLimit: { maxCalls: 2, windowSeconds: 60 },
      toolDefinition: makeToolDef({ execute }),
    })
    const { db } = mockDb(1) // 1 invocation in window — below limit of 2

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    const result = await wrapped.execute({ msg: "hi" })

    expect(result).toBe("result")
    expect(execute).toHaveBeenCalledOnce()
  })

  it("denies on the third call when limit is 2", async () => {
    const execute = makeFakeExecute()
    const tool = makeEffectiveTool({
      rateLimit: { maxCalls: 2, windowSeconds: 60 },
      toolDefinition: makeToolDef({ execute }),
    })
    const { db, insertedRows } = mockDb(2) // Already at limit

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })

    await expect(wrapped.execute({ msg: "hi" })).rejects.toThrow("rate limited")
    expect(execute).not.toHaveBeenCalled()

    // Verify audit log was written for rate_limited
    expect(insertedRows.some((r) => r.event_type === "rate_limited")).toBe(true)
  })

  it("passes through when no rate limit is configured", async () => {
    const execute = makeFakeExecute("done")
    const tool = makeEffectiveTool({ toolDefinition: makeToolDef({ execute }) })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    const result = await wrapped.execute({})

    expect(result).toBe("done")
  })
})

// ---------------------------------------------------------------------------
// CapabilityGuard.wrap — approval policy
// ---------------------------------------------------------------------------

describe("CapabilityGuard.wrap — approval policy", () => {
  it("always_approve creates ApprovalRequest and throws ToolApprovalRequiredError", async () => {
    const approvalService = mockApprovalService("approval-abc")
    const tool = makeEffectiveTool({ approvalPolicy: "always_approve" })
    const { db, insertedRows } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db, approvalService })

    await expect(wrapped.execute({ msg: "hi" })).rejects.toThrow("requires approval")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const createReq = vi.mocked(approvalService.createRequest)
    expect(createReq).toHaveBeenCalledOnce()
    expect(createReq).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        agentId: "agent-1",
        actionType: "tool_invocation",
      }),
    )

    // Audit log records the approval_required event
    expect(insertedRows.some((r) => r.event_type === "approval_required")).toBe(true)
  })

  it("always_approve without ApprovalService throws with 'pending' id", async () => {
    const tool = makeEffectiveTool({ approvalPolicy: "always_approve" })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })

    try {
      await wrapped.execute({})
      expect.unreachable("Should have thrown")
    } catch (err: unknown) {
      const e = err as { approvalRequestId: string }
      expect(e.approvalRequestId).toBe("pending")
    }
  })

  it("conditional + matching input creates ApprovalRequest", async () => {
    const approvalService = mockApprovalService("approval-cond")
    const tool = makeEffectiveTool({
      approvalPolicy: "conditional",
      approvalCondition: { field: "action", operator: "equals", value: "delete" },
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db, approvalService })

    await expect(wrapped.execute({ action: "delete" })).rejects.toThrow("requires approval")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(approvalService.createRequest)).toHaveBeenCalledOnce()
  })

  it("conditional + non-matching input executes immediately", async () => {
    const approvalService = mockApprovalService()
    const execute = makeFakeExecute("ok")
    const tool = makeEffectiveTool({
      approvalPolicy: "conditional",
      approvalCondition: { field: "action", operator: "equals", value: "delete" },
      toolDefinition: makeToolDef({ execute }),
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db, approvalService })
    const result = await wrapped.execute({ action: "read" })

    expect(result).toBe("ok")
    expect(execute).toHaveBeenCalledOnce()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(approvalService.createRequest)).not.toHaveBeenCalled()
  })

  it("auto policy executes immediately", async () => {
    const execute = makeFakeExecute("auto-result")
    const tool = makeEffectiveTool({
      approvalPolicy: "auto",
      toolDefinition: makeToolDef({ execute }),
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    const result = await wrapped.execute({})

    expect(result).toBe("auto-result")
  })
})

// ---------------------------------------------------------------------------
// CapabilityGuard.wrap — data scope injection
// ---------------------------------------------------------------------------

describe("CapabilityGuard.wrap — data scope injection", () => {
  it("injects _cortex_scope into execute input", async () => {
    const execute = makeFakeExecute("scoped")
    const tool = makeEffectiveTool({
      dataScope: { org: "acme", channels: ["general"] },
      toolDefinition: makeToolDef({ execute }),
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    await wrapped.execute({ query: "test" })

    expect(execute).toHaveBeenCalledWith({
      query: "test",
      _cortex_scope: { org: "acme", channels: ["general"] },
    })
  })

  it("passes original input when no data scope", async () => {
    const execute = makeFakeExecute("plain")
    const tool = makeEffectiveTool({
      toolDefinition: makeToolDef({ execute }),
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    await wrapped.execute({ x: 1 })

    expect(execute).toHaveBeenCalledWith({ x: 1 })
  })
})

// ---------------------------------------------------------------------------
// CapabilityGuard.wrap — audit logging
// ---------------------------------------------------------------------------

describe("CapabilityGuard.wrap — audit logging", () => {
  it("writes tool_invoked on successful execution", async () => {
    const tool = makeEffectiveTool({
      toolDefinition: makeToolDef({ execute: makeFakeExecute() }),
    })
    const { db, insertedRows } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    await wrapped.execute({})

    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toEqual(
      expect.objectContaining({
        agent_id: "agent-1",
        tool_ref: "mcp:server:test-tool",
        event_type: "tool_invoked",
        job_id: "job-1",
        actor_user_id: "user-1",
      }),
    )
  })

  it("writes rate_limited when rate limit is exceeded", async () => {
    const tool = makeEffectiveTool({
      rateLimit: { maxCalls: 1, windowSeconds: 60 },
    })
    const { db, insertedRows } = mockDb(1)

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    await expect(wrapped.execute({})).rejects.toThrow()

    expect(insertedRows.some((r) => r.event_type === "rate_limited")).toBe(true)
  })

  it("writes approval_required when approval is needed", async () => {
    const tool = makeEffectiveTool({ approvalPolicy: "always_approve" })
    const { db, insertedRows } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })
    await expect(wrapped.execute({})).rejects.toThrow()

    expect(insertedRows.some((r) => r.event_type === "approval_required")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CapabilityGuard.wrap — preserves ToolDefinition shape
// ---------------------------------------------------------------------------

describe("CapabilityGuard.wrap — ToolDefinition shape", () => {
  it("preserves name, description, and inputSchema from the original tool", () => {
    const tool = makeEffectiveTool({
      toolDefinition: makeToolDef({
        name: "my-tool",
        description: "Does things",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
      }),
    })
    const { db } = mockDb()

    const wrapped = CapabilityGuard.wrap(tool, CTX, { db })

    expect(wrapped.name).toBe("my-tool")
    expect(wrapped.description).toBe("Does things")
    expect(wrapped.inputSchema).toEqual({ type: "object", properties: { x: { type: "number" } } })
  })
})
