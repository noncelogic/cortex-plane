/**
 * Webhook Tool Factory
 *
 * Creates ToolDefinition instances from per-agent custom webhook
 * configurations stored in agent.config.tools.
 *
 * Each webhook tool definition in the agent config has the shape:
 *   {
 *     name: string            — unique tool name
 *     description: string     — description for the LLM
 *     inputSchema: object     — JSON Schema for tool input
 *     webhook: {
 *       url: string           — HTTP endpoint to call
 *       method?: string       — HTTP method (default POST)
 *       headers?: object      — extra headers
 *       timeout_ms?: number   — request timeout (default 30000)
 *     }
 *   }
 */

import type { ToolDefinition } from "../tool-executor.js"

export interface WebhookToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  webhook: {
    url: string
    method?: string
    headers?: Record<string, string>
    timeout_ms?: number
  }
}

const MAX_TIMEOUT_MS = 60_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1_048_576 // 1 MB

/**
 * Create a ToolDefinition from a webhook tool spec.
 * The tool sends the LLM-provided input as a JSON POST body to the
 * configured URL and returns the response body as the tool output.
 */
export function createWebhookTool(spec: WebhookToolSpec): ToolDefinition {
  const method = spec.webhook.method?.toUpperCase() ?? "POST"
  const timeoutMs = Math.min(spec.webhook.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (input) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...spec.webhook.headers,
      }

      const response = await fetch(spec.webhook.url, {
        method,
        headers,
        body: method !== "GET" ? JSON.stringify(input) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        return JSON.stringify({
          error: `Webhook returned ${response.status}: ${response.statusText}`,
          tool: spec.name,
        })
      }

      const body = await response.text()
      if (body.length > MAX_RESPONSE_BYTES) {
        return body.slice(0, MAX_RESPONSE_BYTES)
      }
      return body
    },
  }
}

/**
 * Parse the agent config and extract webhook tool specs.
 * Expects agent.config.tools to be an array of WebhookToolSpec objects.
 */
export function parseWebhookTools(agentConfig: Record<string, unknown>): WebhookToolSpec[] {
  const tools = agentConfig.tools
  if (!Array.isArray(tools)) return []

  const specs: WebhookToolSpec[] = []
  for (const entry of tools) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).name === "string" &&
      typeof (entry as Record<string, unknown>).description === "string" &&
      typeof (entry as Record<string, unknown>).inputSchema === "object" &&
      typeof (entry as Record<string, unknown>).webhook === "object" &&
      (entry as Record<string, unknown>).webhook !== null
    ) {
      const e = entry as Record<string, unknown>
      const webhook = e.webhook as Record<string, unknown>
      if (typeof webhook.url !== "string") continue

      specs.push({
        name: e.name as string,
        description: e.description as string,
        inputSchema: e.inputSchema as Record<string, unknown>,
        webhook: {
          url: webhook.url,
          method: typeof webhook.method === "string" ? webhook.method : undefined,
          headers:
            typeof webhook.headers === "object" && webhook.headers !== null
              ? (webhook.headers as Record<string, string>)
              : undefined,
          timeout_ms: typeof webhook.timeout_ms === "number" ? webhook.timeout_ms : undefined,
        },
      })
    }
  }
  return specs
}
