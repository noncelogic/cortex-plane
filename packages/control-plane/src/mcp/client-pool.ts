/**
 * MCP Client Pool
 *
 * Manages persistent connections to MCP servers using the official
 * @modelcontextprotocol/sdk. Supports Streamable HTTP and stdio transports.
 *
 * Lifecycle:
 *   connect(server)   — establish SDK client, perform initialize handshake
 *   callTool(...)     — execute a tool call on an established connection
 *   listTools(...)    — refresh the tool catalogue from the server
 *   ping(...)         — measure round-trip latency
 *   disconnect(...)   — close a single connection
 *   disconnectAll()   — close all connections (graceful shutdown)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { McpServer } from "../db/types.js"
import type { McpClientConnection, McpClientPoolOptions, McpToolInfo } from "./types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  maxConnections: 10,
  defaultTimeoutMs: 30_000,
  protocolVersion: "2025-11-25",
  originHeader: "https://cortex-plane.local",
} as const satisfies Required<McpClientPoolOptions>

const CLIENT_INFO = { name: "cortex-plane", version: "0.1.0" } as const

// ---------------------------------------------------------------------------
// Internal pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  client: Client
  connection: McpClientConnection
}

// ---------------------------------------------------------------------------
// McpClientPool
// ---------------------------------------------------------------------------

export class McpClientPool {
  private readonly opts: Required<McpClientPoolOptions>
  private readonly connections = new Map<string, PoolEntry>()

  constructor(options: McpClientPoolOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...options }
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  /**
   * Connect to an MCP server and perform the initialize handshake.
   *
   * If the server is already connected, returns the existing connection.
   * Throws if `maxConnections` would be exceeded.
   */
  async connect(server: McpServer): Promise<McpClientConnection> {
    const existing = this.connections.get(server.id)
    if (existing) return existing.connection

    if (this.connections.size >= this.opts.maxConnections) {
      throw new Error(
        `McpClientPool: max connections (${this.opts.maxConnections}) reached — ` +
          `disconnect an existing server before adding "${server.slug}"`,
      )
    }

    const client = new Client(CLIENT_INFO, { capabilities: {} })
    const transport = this.buildTransport(server)

    await client.connect(transport)

    const serverVersion = client.getServerVersion()
    const rawCaps = client.getServerCapabilities()

    const connection: McpClientConnection = {
      serverId: server.id,
      transport: server.transport,
      protocolVersion: this.opts.protocolVersion,
      serverInfo: {
        name: serverVersion?.name ?? server.name,
        version: serverVersion?.version ?? "unknown",
      },
      capabilities: (rawCaps as Record<string, unknown>) ?? {},
      sessionId: null,
      connectedAt: new Date(),
    }

    this.connections.set(server.id, { client, connection })
    return connection
  }

  /**
   * Disconnect from a server, closing the MCP session.
   * No-op if the server is not connected.
   */
  async disconnect(serverId: string): Promise<void> {
    const entry = this.connections.get(serverId)
    if (!entry) return
    try {
      await entry.client.close()
    } finally {
      this.connections.delete(serverId)
    }
  }

  /**
   * Disconnect all servers. Called during graceful shutdown.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  // -------------------------------------------------------------------------
  // Tool operations
  // -------------------------------------------------------------------------

  /**
   * Execute a tool call against a specific MCP server.
   *
   * Returns `{ output: string; isError: boolean }`.
   * Timeouts return `{ output: "Timeout after Xms", isError: true }`.
   * The connection must be established before calling.
   */
  async callTool(
    serverId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<{ output: string; isError: boolean }> {
    const entry = this.getEntryOrThrow(serverId)
    const timeoutMs = options?.timeoutMs ?? this.opts.defaultTimeoutMs

    try {
      const result = await entry.client.callTool({ name: toolName, arguments: input }, undefined, {
        timeout: timeoutMs,
      })

      const isError = result.isError === true
      const output = extractTextContent(result.content)
      return { output, isError }
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        return { output: `Timeout after ${timeoutMs}ms`, isError: true }
      }
      // Attempt one reconnect for transport errors
      const server = entry.connection
      const wasTransportError = isTransportError(err)
      if (wasTransportError) {
        try {
          await this.reconnect(serverId, server)
          const retry = await this.connections
            .get(serverId)!
            .client.callTool({ name: toolName, arguments: input }, undefined, {
              timeout: timeoutMs,
            })
          const isError = retry.isError === true
          return { output: extractTextContent(retry.content), isError }
        } catch {
          // Reconnect failed — remove stale entry
          this.connections.delete(serverId)
        }
      }
      throw err
    }
  }

  /**
   * Fetch the current tool list from the server.
   */
  async listTools(serverId: string): Promise<McpToolInfo[]> {
    const entry = this.getEntryOrThrow(serverId)
    const result = await entry.client.listTools(undefined, {
      timeout: this.opts.defaultTimeoutMs,
    })
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema as Record<string, unknown>,
      annotations: t.annotations ? (t.annotations as Record<string, unknown>) : undefined,
    }))
  }

  /**
   * Send a ping to verify connectivity.
   */
  async ping(serverId: string): Promise<{ latencyMs: number }> {
    const entry = this.getEntryOrThrow(serverId)
    const start = Date.now()
    await entry.client.ping({ timeout: this.opts.defaultTimeoutMs })
    return { latencyMs: Date.now() - start }
  }

  // -------------------------------------------------------------------------
  // Status queries
  // -------------------------------------------------------------------------

  getConnection(serverId: string): McpClientConnection | undefined {
    return this.connections.get(serverId)?.connection
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId)
  }

  getConnectionCount(): number {
    return this.connections.size
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildTransport(server: McpServer): StreamableHTTPClientTransport | StdioClientTransport {
    if (server.transport === "streamable-http") {
      const conn = server.connection as { url?: string }
      if (!conn.url) {
        throw new Error(`MCP server "${server.slug}" has no connection URL`)
      }
      return new StreamableHTTPClientTransport(new URL(conn.url), {
        requestInit: {
          headers: {
            "MCP-Protocol-Version": this.opts.protocolVersion,
            Origin: this.opts.originHeader,
          },
        },
      })
    }

    if (server.transport === "stdio") {
      const conn = server.connection as { command?: string; args?: string[] }
      if (!conn.command) {
        throw new Error(`MCP server "${server.slug}" has no stdio command`)
      }
      return new StdioClientTransport({
        command: conn.command,
        args: conn.args ?? [],
      })
    }

    throw new Error(`McpClientPool: unsupported transport "${String(server.transport)}"`)
  }

  private getEntryOrThrow(serverId: string): PoolEntry {
    const entry = this.connections.get(serverId)
    if (!entry) {
      throw new Error(
        `McpClientPool: no active connection for server "${serverId}" — call connect() first`,
      )
    }
    return entry
  }

  private async reconnect(serverId: string, connection: McpClientConnection): Promise<void> {
    this.connections.delete(serverId)
    const client = new Client(CLIENT_INFO, { capabilities: {} })

    // Re-build a minimal McpServer shape from the stored connection metadata
    // (only transport and slug are needed by buildTransport)
    const fakeServer = {
      id: serverId,
      slug: connection.serverInfo.name,
      transport: connection.transport,
      name: connection.serverInfo.name,
      connection: {}, // buildTransport will fail for non-HTTP without real connection data
    } as McpServer

    const transport = this.buildTransport(fakeServer)
    await client.connect(transport)

    const serverVersion = client.getServerVersion()
    const rawCaps = client.getServerCapabilities()

    const newConn: McpClientConnection = {
      ...connection,
      capabilities: (rawCaps as Record<string, unknown>) ?? connection.capabilities,
      serverInfo: {
        name: serverVersion?.name ?? connection.serverInfo.name,
        version: serverVersion?.version ?? connection.serverInfo.version,
      },
    }

    this.connections.set(serverId, { client, connection: newConn })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ContentItem = { type: string; text?: string }

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? {})
  const parts = (content as ContentItem[])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
  if (parts.length > 0) return parts.join("\n")
  // Fall back to JSON for non-text content
  return JSON.stringify(content)
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    (err as { code?: number }).code === -32001
  )
}

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("connection") ||
    msg.includes("transport") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset")
  )
}
