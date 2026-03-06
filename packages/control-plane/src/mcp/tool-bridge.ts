/**
 * MCP Tool Bridge
 *
 * Adapts an MCP server tool record into a ToolDefinition that can be
 * registered in the existing ToolRegistry.  Execution delegates to the
 * MCP client pool which manages transport-level communication.
 */

import type { ToolDefinition } from "../backends/tool-executor.js"
import type { McpServer, McpServerTool } from "../db/types.js"

/**
 * Minimal interface for the MCP client pool dependency.
 * Only the capabilities required by the bridge are listed here.
 */
export interface McpClientPool {
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }>
  isConnected(serverId: string): boolean
  connect(server: McpServer): Promise<unknown>
}

/**
 * Build the qualified MCP tool name: `mcp:<server-slug>:<tool-name>`.
 */
export function qualifiedName(serverSlug: string, toolName: string): string {
  return `mcp:${serverSlug}:${toolName}`
}

/**
 * Parse a qualified MCP tool name into its components.
 * Returns null if the name does not match `mcp:<slug>:<name>`.
 */
export function parseQualifiedName(name: string): { serverSlug: string; toolName: string } | null {
  if (!name.startsWith("mcp:")) return null
  const parts = name.split(":")
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null
  return { serverSlug: parts[1], toolName: parts[2] }
}

/**
 * Bridge an MCP server tool into a ToolDefinition.
 *
 * The returned definition uses the qualified name as the tool name so
 * there is no ambiguity when multiple servers expose identically-named
 * tools.  Execution calls through the client pool.
 *
 * If the pool is not yet connected to the server, connect() is called
 * lazily on the first tool invocation.
 */
export function createMcpToolDefinition(
  pool: McpClientPool,
  server: McpServer,
  tool: McpServerTool,
): ToolDefinition {
  const qName = qualifiedName(server.slug, tool.name)
  return {
    name: qName,
    description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
    inputSchema: tool.input_schema,
    execute: async (input: Record<string, unknown>) => {
      if (!pool.isConnected(server.id)) {
        await pool.connect(server)
      }
      const { output, isError } = await pool.callTool(server.id, tool.name, input)
      if (isError) {
        throw new Error(`MCP tool error: ${output}`)
      }
      return output
    },
  }
}
