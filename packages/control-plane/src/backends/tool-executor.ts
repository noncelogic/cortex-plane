/**
 * Tool Executor
 *
 * Provides a simple tool execution framework for the agentic iteration loop.
 * Tools are registered with a name, description, JSON Schema, and handler.
 */

import type { ToolCredentialRef, ToolExecutionContext } from "@cortex/shared/backends"
import pino from "pino"

import type { CredentialService } from "../auth/credential-service.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import { createHttpRequestTool } from "./tools/http-request.js"
import { createMemoryQueryTool } from "./tools/memory-query.js"
import { createMemoryStoreTool } from "./tools/memory-store.js"
import { createWebSearchTool } from "./tools/web-search.js"
import { createWebhookTool, parseWebhookTools, type WebhookToolSpec } from "./tools/webhook.js"

const logger = pino({ name: "tool-executor" })

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
 * Resolve credential references into HTTP headers for tool injection.
 *
 * For each ToolCredentialRef with injectAs === "header":
 *   - user_service → credentialService.getAccessToken(userId, provider)
 *   - tool_secret  → credentialService.getToolSecret(provider)
 *
 * Failed resolutions are logged but do NOT throw — the tool call
 * itself will fail with a descriptive error if a required header
 * cannot be built.
 */
export async function resolveToolCredentialHeaders(
  refs: ToolCredentialRef[],
  ctx: ToolExecutionContext,
  credentialService: CredentialService,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}

  for (const ref of refs) {
    if (ref.injectAs !== "header") continue

    try {
      let token: string | null = null
      let credentialId: string | null = null

      if (ref.credentialClass === "user_service") {
        const result = await credentialService.getAccessToken(ctx.userId, ref.provider)
        if (result) {
          token = result.token
          credentialId = result.credentialId
        }
      } else if (ref.credentialClass === "tool_secret") {
        const result = await credentialService.getToolSecret(ref.provider)
        if (result) {
          token = result.token
          credentialId = result.credentialId
        }
      }

      if (token && ref.headerName) {
        const formatted = ref.format === "bearer" ? `Bearer ${token}` : token
        headers[ref.headerName] = formatted

        // Audit log — log credential access without exposing the token
        logger.info(
          {
            agent_id: ctx.agentId,
            job_id: ctx.jobId,
            credential_id: credentialId,
            credential_class: ref.credentialClass,
            provider: ref.provider,
          },
          "credential_injected",
        )
      } else if (!token) {
        logger.warn(
          {
            agent_id: ctx.agentId,
            job_id: ctx.jobId,
            credential_class: ref.credentialClass,
            provider: ref.provider,
          },
          "credential_not_found",
        )
      }
    } catch (err) {
      logger.error(
        {
          agent_id: ctx.agentId,
          job_id: ctx.jobId,
          credential_class: ref.credentialClass,
          provider: ref.provider,
          err,
        },
        "credential_resolution_failed",
      )
    }
  }

  return headers
}

/**
 * Create a tool registry for a specific agent.
 *
 * Starts with the default built-in tools, then registers any custom
 * webhook tools defined in the agent's config.tools array.
 *
 * When an McpToolRouter is provided, MCP tools available to the agent
 * are resolved and merged into the registry.
 *
 * When credentialService and executionContext are provided, tool credentials
 * are resolved and injected into webhook tool headers.
 */
export async function createAgentToolRegistry(
  agentConfig: Record<string, unknown>,
  opts?: {
    agentId?: string
    mcpRouter?: McpToolRouter
    allowedTools?: string[]
    deniedTools?: string[]
    credentialService?: CredentialService
    executionContext?: ToolExecutionContext
  },
): Promise<ToolRegistry> {
  const registry = createDefaultToolRegistry()

  const webhookSpecs = parseWebhookTools(agentConfig)
  for (const spec of webhookSpecs) {
    const resolvedHeaders = await resolveWebhookCredentials(spec, opts)
    registry.register(createWebhookTool(spec, resolvedHeaders))
  }

  // Merge MCP tools when a router is available
  if (opts?.mcpRouter && opts.agentId) {
    const mcpTools = await opts.mcpRouter.resolveAll(
      opts.agentId,
      opts.allowedTools ?? [],
      opts.deniedTools ?? [],
    )
    for (const tool of mcpTools) {
      registry.register(tool)
    }
  }

  // Inject tool_secret credentials into built-in tools that support them.
  // For web_search: resolve "brave" tool_secret and re-register with the key.
  if (opts?.credentialService) {
    try {
      const braveSecret = await opts.credentialService.getToolSecret("brave")
      if (braveSecret) {
        registry.register(createWebSearchTool({ apiKey: braveSecret.token }))
        if (opts.executionContext) {
          logger.info(
            {
              agent_id: opts.executionContext.agentId,
              job_id: opts.executionContext.jobId,
              credential_id: braveSecret.credentialId,
              tool_name: "web_search",
            },
            "tool_secret_injected",
          )
        }
      }
    } catch {
      // Non-fatal: fall back to env var SEARCH_API_KEY
    }
  }

  return registry
}

/** Resolve credentials for a single webhook tool spec. */
async function resolveWebhookCredentials(
  spec: WebhookToolSpec,
  opts?: {
    credentialService?: CredentialService
    executionContext?: ToolExecutionContext
  },
): Promise<Record<string, string> | undefined> {
  if (!spec.credentials?.length || !opts?.credentialService || !opts.executionContext) {
    return undefined
  }

  return resolveToolCredentialHeaders(
    spec.credentials,
    opts.executionContext,
    opts.credentialService,
  )
}
