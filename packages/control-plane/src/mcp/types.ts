/**
 * MCP Client Pool — shared types
 */

export interface McpClientPoolOptions {
  /** Maximum number of simultaneous server connections. Default: 10. */
  maxConnections?: number
  /** Default per-operation timeout in milliseconds. Default: 30000. */
  defaultTimeoutMs?: number
  /** MCP protocol version to advertise. Default: "2025-11-25". */
  protocolVersion?: string
  /** Origin header value sent on every HTTP request. Default: "https://cortex-plane.local". */
  originHeader?: string
}

export interface McpClientConnection {
  serverId: string
  transport: "streamable-http" | "stdio"
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: Record<string, unknown>
  sessionId: string | null
  connectedAt: Date
}

export interface McpToolInfo {
  name: string
  description: string | null
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface SidecarConnectionOptions {
  podName: string
  containerName: string
  namespace: string
  command: string[]
}
