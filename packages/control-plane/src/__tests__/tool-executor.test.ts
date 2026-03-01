import { describe, expect, it } from "vitest"

import { createDefaultToolRegistry, echoTool, ToolRegistry } from "../backends/tool-executor.js"

// ---------------------------------------------------------------------------
// echoTool
// ---------------------------------------------------------------------------

describe("echoTool", () => {
  it("echoes back the input text", async () => {
    const result = await echoTool.execute({ text: "hello world" })
    expect(result).toBe("hello world")
  })

  it("serialises non-string input as JSON", async () => {
    const result = await echoTool.execute({ num: 42 })
    expect(result).toBe('{"num":42}')
  })

  it("has a valid input schema", () => {
    expect(echoTool.inputSchema).toEqual({
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo back" },
      },
      required: ["text"],
    })
  })
})

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    expect(registry.get("echo")).toBe(echoTool)
  })

  it("returns undefined for unknown tools", () => {
    const registry = new ToolRegistry()
    expect(registry.get("nonexistent")).toBeUndefined()
  })

  it("executes a registered tool", async () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const { output, isError } = await registry.execute("echo", { text: "test" })
    expect(output).toBe("test")
    expect(isError).toBe(false)
  })

  it("returns error for unknown tool execution", async () => {
    const registry = new ToolRegistry()
    const { output, isError } = await registry.execute("missing", {})
    expect(output).toContain("Unknown tool")
    expect(isError).toBe(true)
  })

  it("catches tool execution errors", async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "failing",
      description: "Always fails",
      inputSchema: { type: "object", properties: {} },
      execute: () => Promise.reject(new Error("boom")),
    })
    const { output, isError } = await registry.execute("failing", {})
    expect(output).toBe("boom")
    expect(isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// resolve (allowedTools / deniedTools filtering)
// ---------------------------------------------------------------------------

describe("ToolRegistry.resolve", () => {
  it("returns empty when allowedTools is empty", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.resolve([], [])).toEqual([])
  })

  it("returns matching tools from allowedTools", () => {
    const registry = createDefaultToolRegistry()
    const tools = registry.resolve(["echo"], [])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("echo")
  })

  it("excludes tools in deniedTools", () => {
    const registry = createDefaultToolRegistry()
    const tools = registry.resolve(["echo"], ["echo"])
    expect(tools).toHaveLength(0)
  })

  it("ignores allowed tools that do not exist in registry", () => {
    const registry = createDefaultToolRegistry()
    const tools = registry.resolve(["echo", "nonexistent"], [])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("echo")
  })
})

// ---------------------------------------------------------------------------
// createDefaultToolRegistry
// ---------------------------------------------------------------------------

describe("createDefaultToolRegistry", () => {
  it("includes the echo tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("echo")).toBeDefined()
  })
})
