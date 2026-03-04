/**
 * MCP Client Pool
 *
 * Concrete implementation of the McpClientPool interface.
 * Calls MCP servers via Streamable HTTP transport to execute tools.
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { McpClientPool } from "./tool-bridge.js"

export interface HttpMcpClientPoolDeps {
  db: Kysely<Database>
}

/**
 * HTTP-based MCP client pool.
 *
 * Looks up the server connection URL from the database and issues
 * a standard MCP `tools/call` JSON-RPC request.
 */
export class HttpMcpClientPool implements McpClientPool {
  private db: Kysely<Database>

  constructor(deps: HttpMcpClientPoolDeps) {
    this.db = deps.db
  }

  async callTool(
    serverSlug: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = await this.db
      .selectFrom("mcp_server")
      .select(["connection", "status"])
      .where("slug", "=", serverSlug)
      .where("status", "in", ["ACTIVE", "DEGRADED"])
      .executeTakeFirst()

    if (!server) {
      throw new Error(`MCP server "${serverSlug}" not found or not active`)
    }

    const connection = server.connection
    const url = connection.url as string | undefined

    if (!url) {
      throw new Error(`MCP server "${serverSlug}" has no connection URL`)
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: crypto.randomUUID(),
      }),
    })

    if (!response.ok) {
      throw new Error(
        `MCP server "${serverSlug}" returned HTTP ${response.status}: ${response.statusText}`,
      )
    }

    const body = (await response.json()) as {
      result?: { content?: Array<{ type: string; text?: string }> }
      error?: { message?: string }
    }

    if (body.error) {
      throw new Error(body.error.message ?? "MCP tool call failed")
    }

    // Extract text content from standard MCP tool result
    const content = body.result?.content
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n")
    }

    return JSON.stringify(body.result ?? {})
  }
}
