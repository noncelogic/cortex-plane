/**
 * CapabilityAssembler
 *
 * Resolves the effective set of tools for an agent from agent_tool_binding
 * rows and builds a guarded ToolRegistry for execution.
 */

import type { Kysely } from "kysely"

import type { ToolDefinition } from "../backends/tool-executor.js"
import { createDefaultToolRegistry, ToolRegistry } from "../backends/tool-executor.js"
import type { Database } from "../db/types.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import { isExecutableToolDefinition } from "./contracts.js"
import { CapabilityGuard } from "./guard.js"
import type { EffectiveTool } from "./types.js"

export class CapabilityAssembler {
  private readonly db: Kysely<Database>
  private readonly mcpToolRouter?: McpToolRouter
  private readonly defaultRegistry: ToolRegistry

  constructor(deps: {
    db: Kysely<Database>
    mcpToolRouter?: McpToolRouter
    defaultRegistry?: ToolRegistry
  }) {
    this.db = deps.db
    this.mcpToolRouter = deps.mcpToolRouter
    this.defaultRegistry = deps.defaultRegistry ?? createDefaultToolRegistry()
  }

  /**
   * Resolve all effective tools for an agent from agent_tool_binding rows.
   *
   * For each enabled binding:
   *  - Built-in tool refs are looked up in the default registry.
   *  - MCP tool refs (prefixed 'mcp:') are resolved via the McpToolRouter.
   *  - Unresolvable refs are silently skipped (fail closed).
   */
  async resolveEffectiveTools(agentId: string): Promise<EffectiveTool[]> {
    const bindings = await this.db
      .selectFrom("agent_tool_binding")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("enabled", "=", true)
      .execute()

    const effectiveTools: EffectiveTool[] = []

    for (const binding of bindings) {
      const toolDef = this.defaultRegistry.get(binding.tool_ref)

      if (toolDef && isExecutableToolDefinition(toolDef)) {
        // Built-in tool
        effectiveTools.push(this.bindingToEffectiveTool(binding, toolDef))
      } else if (binding.tool_ref.startsWith("mcp:") && this.mcpToolRouter) {
        // MCP tool — resolve via router
        try {
          const mcpTool = await this.mcpToolRouter.resolve(binding.tool_ref, agentId)
          if (mcpTool && isExecutableToolDefinition(mcpTool)) {
            effectiveTools.push(this.bindingToEffectiveTool(binding, mcpTool))
          }
        } catch {
          // MCP tool resolution failure — skip (fail closed).
        }
      }
      // Unknown tool ref with no MCP prefix → skip silently.
    }

    return effectiveTools
  }

  /**
   * Build a ToolRegistry where every tool is wrapped with a CapabilityGuard.
   * The registry contains exactly the tools in effectiveTools — no
   * allowedTools/deniedTools filtering is needed at LLM call time.
   */
  buildGuardedRegistry(
    effectiveTools: EffectiveTool[],
    executionContext: { agentId: string; jobId: string; userId: string },
  ): ToolRegistry {
    const registry = new ToolRegistry()

    for (const tool of effectiveTools) {
      const guarded = CapabilityGuard.wrap(tool, executionContext, { db: this.db })
      registry.register(guarded)
    }

    return registry
  }

  private bindingToEffectiveTool(
    binding: {
      id: string
      tool_ref: string
      approval_policy: string
      approval_condition: Record<string, unknown> | null
      rate_limit: Record<string, unknown> | null
      cost_budget: Record<string, unknown> | null
      data_scope: Record<string, unknown> | null
    },
    toolDef: ToolDefinition,
  ): EffectiveTool {
    return {
      toolRef: binding.tool_ref,
      bindingId: binding.id,
      approvalPolicy: binding.approval_policy as EffectiveTool["approvalPolicy"],
      approvalCondition: binding.approval_condition ?? undefined,
      rateLimit: binding.rate_limit as EffectiveTool["rateLimit"],
      costBudget: binding.cost_budget as EffectiveTool["costBudget"],
      dataScope: binding.data_scope ?? undefined,
      source: { kind: binding.tool_ref.startsWith("mcp:") ? "mcp" : "builtin" },
      toolDefinition: toolDef,
    }
  }
}
