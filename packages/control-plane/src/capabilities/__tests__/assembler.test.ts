import { describe, expect, it, vi } from "vitest"

import { echoTool, ToolRegistry } from "../../backends/tool-executor.js"
import type { McpToolRouter } from "../../mcp/tool-router.js"
import { CapabilityAssembler } from "../assembler.js"
import { CapabilityGuard } from "../guard.js"
import type { EffectiveTool } from "../types.js"

// ── Mock helpers ──

function mockDb(bindings: Record<string, unknown>[] = []) {
  return {
    selectFrom: vi.fn().mockReturnValue({
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: vi.fn().mockResolvedValue(bindings),
          }),
        }),
      }),
    }),
    // Guard needs insertInto for audit logging
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as never
}

function makeBinding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "binding-1",
    agent_id: "agent-1",
    tool_ref: "echo",
    approval_policy: "auto",
    approval_condition: null,
    rate_limit: null,
    cost_budget: null,
    data_scope: null,
    enabled: true,
    ...overrides,
  }
}

// ── Tests ──

describe("CapabilityAssembler", () => {
  describe("resolveEffectiveTools", () => {
    it("resolves built-in tools from bindings", async () => {
      const db = mockDb([makeBinding({ tool_ref: "echo" })])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")

      expect(tools).toHaveLength(1)
      expect(tools[0]!.toolRef).toBe("echo")
      expect(tools[0]!.bindingId).toBe("binding-1")
      expect(tools[0]!.approvalPolicy).toBe("auto")
      expect(tools[0]!.toolDefinition.name).toBe("echo")
    })

    it("returns empty array when agent has no bindings", async () => {
      const db = mockDb([])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toEqual([])
    })

    it("skips unknown built-in tool refs", async () => {
      const db = mockDb([makeBinding({ tool_ref: "nonexistent_tool" })])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toEqual([])
    })

    it("fails closed for configured tools without an executable definition", async () => {
      const registry = new ToolRegistry()
      registry.register({
        name: "broken_tool",
        description: "broken",
        inputSchema: { type: "object" },
        execute: undefined as never,
      })

      const db = mockDb([makeBinding({ tool_ref: "broken_tool" })])
      const assembler = new CapabilityAssembler({ db, defaultRegistry: registry })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toEqual([])
    })

    it("resolves MCP tools via McpToolRouter", async () => {
      const mcpToolDef = {
        name: "mcp:slack:chat_post",
        description: "Post a Slack message",
        inputSchema: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue("ok"),
      }

      const mockRouter = {
        resolve: vi.fn().mockResolvedValue(mcpToolDef),
      } as unknown as McpToolRouter

      const db = mockDb([makeBinding({ tool_ref: "mcp:slack:chat_post", id: "binding-mcp" })])
      const assembler = new CapabilityAssembler({ db, mcpToolRouter: mockRouter })

      const tools = await assembler.resolveEffectiveTools("agent-1")

      expect(tools).toHaveLength(1)
      expect(tools[0]!.toolRef).toBe("mcp:slack:chat_post")
      expect(tools[0]!.bindingId).toBe("binding-mcp")
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockRouter.resolve).toHaveBeenCalledWith("mcp:slack:chat_post", "agent-1")
    })

    it("skips MCP tools when router returns null", async () => {
      const mockRouter = {
        resolve: vi.fn().mockResolvedValue(null),
      } as unknown as McpToolRouter

      const db = mockDb([makeBinding({ tool_ref: "mcp:slack:missing_tool" })])
      const assembler = new CapabilityAssembler({ db, mcpToolRouter: mockRouter })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toEqual([])
    })

    it("skips MCP tools when router is not provided", async () => {
      const db = mockDb([makeBinding({ tool_ref: "mcp:slack:chat_post" })])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toEqual([])
    })

    it("preserves binding metadata (rate_limit, data_scope, approval)", async () => {
      const db = mockDb([
        makeBinding({
          tool_ref: "echo",
          approval_policy: "always_approve",
          rate_limit: { maxCalls: 10, windowSeconds: 60 },
          data_scope: { read_only: true },
        }),
      ])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")

      expect(tools[0]!.approvalPolicy).toBe("always_approve")
      expect(tools[0]!.rateLimit).toEqual({ maxCalls: 10, windowSeconds: 60 })
      expect(tools[0]!.dataScope).toEqual({ read_only: true })
    })

    it("resolves multiple tools (2 bound, 1 unknown skipped)", async () => {
      const db = mockDb([
        makeBinding({ id: "b1", tool_ref: "echo" }),
        makeBinding({ id: "b2", tool_ref: "web_search" }),
      ])
      const assembler = new CapabilityAssembler({ db })

      const tools = await assembler.resolveEffectiveTools("agent-1")
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.toolRef)).toEqual(["echo", "web_search"])
    })
  })

  describe("buildGuardedRegistry", () => {
    it("creates a ToolRegistry with guarded tools", () => {
      const db = mockDb()
      const assembler = new CapabilityAssembler({ db })

      const effectiveTools: EffectiveTool[] = [
        {
          toolRef: "echo",
          bindingId: "b1",
          approvalPolicy: "auto",
          source: { kind: "builtin" },
          toolDefinition: echoTool,
        },
      ]

      const registry = assembler.buildGuardedRegistry(effectiveTools, {
        agentId: "agent-1",
        jobId: "job-1",
        userId: "user-1",
      })

      expect(registry).toBeInstanceOf(ToolRegistry)
      expect(registry.get("echo")).toBeDefined()
      expect(registry.get("echo")!.name).toBe("echo")
    })

    it("returns empty registry when no effective tools", () => {
      const db = mockDb()
      const assembler = new CapabilityAssembler({ db })

      const registry = assembler.buildGuardedRegistry([], {
        agentId: "agent-1",
        jobId: "job-1",
        userId: "user-1",
      })

      expect(registry.get("echo")).toBeUndefined()
    })

    it("guarded tool executes successfully for auto policy", async () => {
      const db = mockDb()
      const assembler = new CapabilityAssembler({ db })

      const effectiveTools: EffectiveTool[] = [
        {
          toolRef: "echo",
          bindingId: "b1",
          approvalPolicy: "auto",
          source: { kind: "builtin" },
          toolDefinition: echoTool,
        },
      ]

      const registry = assembler.buildGuardedRegistry(effectiveTools, {
        agentId: "agent-1",
        jobId: "job-1",
        userId: "user-1",
      })

      const tool = registry.get("echo")!
      const result = await tool.execute({ text: "hello" })
      expect(result).toBe("hello")
    })
  })
})

describe("CapabilityGuard", () => {
  it("wraps tool and preserves name/description/schema", () => {
    const db = mockDb()
    const tool: EffectiveTool = {
      toolRef: "echo",
      bindingId: "b1",
      approvalPolicy: "auto",
      source: { kind: "builtin" },
      toolDefinition: echoTool,
    }

    const wrapped = CapabilityGuard.wrap(tool, { agentId: "a1", jobId: "j1", userId: "u1" }, { db })

    expect(wrapped.name).toBe("echo")
    expect(wrapped.description).toBe(echoTool.description)
    expect(wrapped.inputSchema).toBe(echoTool.inputSchema)
  })

  it("injects _cortex_scope when dataScope is set", async () => {
    const executeSpy = vi.fn().mockResolvedValue("ok")
    const db = mockDb()
    const tool: EffectiveTool = {
      toolRef: "echo",
      bindingId: "b1",
      approvalPolicy: "auto",
      dataScope: { calendars: ["primary"] },
      source: { kind: "builtin" },
      toolDefinition: {
        name: "test",
        description: "test",
        inputSchema: { type: "object" },
        execute: executeSpy,
      },
    }

    const wrapped = CapabilityGuard.wrap(tool, { agentId: "a1", jobId: "j1", userId: "u1" }, { db })

    await wrapped.execute({ query: "meetings" })

    expect(executeSpy).toHaveBeenCalledWith({
      query: "meetings",
      _cortex_scope: { calendars: ["primary"] },
    })
  })

  it("throws ToolApprovalRequiredError for always_approve policy", async () => {
    const db = mockDb()
    const tool: EffectiveTool = {
      toolRef: "echo",
      bindingId: "b1",
      approvalPolicy: "always_approve",
      source: { kind: "builtin" },
      toolDefinition: echoTool,
    }

    const wrapped = CapabilityGuard.wrap(tool, { agentId: "a1", jobId: "j1", userId: "u1" }, { db })

    await expect(wrapped.execute({ text: "hello" })).rejects.toThrow("requires approval")
  })
})
