/**
 * Tool Executor
 *
 * Provides a simple tool execution framework for the agentic iteration loop.
 * Tools are registered with a name, description, JSON Schema, and handler.
 */

import { createHttpRequestTool } from "./tools/http-request.js"
import { createMemoryQueryTool } from "./tools/memory-query.js"
import { createMemoryStoreTool } from "./tools/memory-store.js"
import { createWebSearchTool } from "./tools/web-search.js"
import { createWebhookTool, parseWebhookTools } from "./tools/webhook.js"

export interface ToolDefinition {
  /** Unique tool name (sent to the LLM). */
  name: string
  /** Human-readable description for the LLM. */
  description: string
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>
  /** Execute the tool and return output text. */
  execute: (input: Record<string, unknown>) => Promise<string>
}

/**
 * Registry of available tools keyed by name.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /**
   * Return tool definitions filtered by the task's allowed/denied lists.
   * Per the TaskConstraints contract, an empty allowedTools array means
   * "no tools" — the caller must opt-in by listing tool names.
   */
  resolve(allowedTools: string[], deniedTools: string[]): ToolDefinition[] {
    if (allowedTools.length === 0) return []

    const allowed = new Set(allowedTools)
    const denied = new Set(deniedTools)
    return [...this.tools.values()].filter((t) => allowed.has(t.name) && !denied.has(t.name))
  }

  /** Execute a tool call by name. */
  async execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { output: `Unknown tool: ${name}`, isError: true }
    }
    try {
      const result = await tool.execute(input)
      return { output: result, isError: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Tool execution failed"
      return { output: message, isError: true }
    }
  }
}

/**
 * Built-in echo tool — returns the input text unchanged.
 * Useful for testing the agentic iteration loop.
 */
export const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back the provided text unchanged. Useful for testing.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to echo back" },
    },
    required: ["text"],
  },
  execute: (input) => {
    const text = typeof input.text === "string" ? input.text : JSON.stringify(input)
    return Promise.resolve(text)
  },
}

/** Create a default registry with built-in tools. */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(echoTool)
  registry.register(createWebSearchTool())
  registry.register(createMemoryQueryTool())
  registry.register(createMemoryStoreTool())
  registry.register(createHttpRequestTool())
  return registry
}

/**
 * Create a tool registry for a specific agent.
 *
 * Starts with the default built-in tools, then registers any custom
 * webhook tools defined in the agent's config.tools array.
 */
export function createAgentToolRegistry(agentConfig: Record<string, unknown>): ToolRegistry {
  const registry = createDefaultToolRegistry()

  const webhookSpecs = parseWebhookTools(agentConfig)
  for (const spec of webhookSpecs) {
    registry.register(createWebhookTool(spec))
  }

  return registry
}
