/**
 * MCP Tool Router
 *
 * Resolves MCP tools by qualified or unqualified name with conflict
 * handling, glob-based allow/deny filtering, and a TTL cache.
 *
 * Resolution order for unqualified names:
 *   1. Agent scope  — if only one server includes this agent in agent_scope
 *   2. Agent preference — agent.config.mcp_preferences.server_priority
 *   3. First registered — mcp_server.created_at ASC
 *   4. Ambiguity error  — asks for a qualified name
 */

import type { Kysely } from "kysely"

import type { ToolDefinition } from "../backends/tool-executor.js"
import type { Database, McpServer, McpServerTool } from "../db/types.js"
import type { McpClientPool } from "./tool-bridge.js"
import { createMcpToolDefinition, parseQualifiedName, qualifiedName } from "./tool-bridge.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolRouterDeps {
  db: Kysely<Database>
  clientPool: McpClientPool
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/** Joined row returned by the resolveAll query. */
interface ToolWithServer {
  tool: McpServerTool
  server: McpServer
}

// ---------------------------------------------------------------------------
// Glob helpers
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern (supporting `*` as wildcard) into a RegExp.
 * Only `*` is supported — it maps to `[^:]*` when inside the qualified name
 * structure and `.*` at the tail.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/([.+?^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

function matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === name) return true
    if (p.includes("*")) return globToRegex(p).test(name)
    return false
  })
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000

// ---------------------------------------------------------------------------
// McpToolRouter
// ---------------------------------------------------------------------------

export class McpToolRouter {
  private db: Kysely<Database>
  private clientPool: McpClientPool
  private cache = new Map<string, CacheEntry<unknown>>()

  constructor(deps: McpToolRouterDeps) {
    this.db = deps.db
    this.clientPool = deps.clientPool
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve a single tool name to a ToolDefinition.
   *
   * 1. Qualified MCP name (`mcp:<slug>:<name>`) → direct lookup
   * 2. Unqualified name → search mcp_server_tool table
   *    - 0 results → null (fall through to webhook/built-in)
   *    - 1 result  → return it
   *    - N results → conflict resolution
   */
  async resolve(
    toolName: string,
    agentId: string,
    agentConfig?: Record<string, unknown>,
  ): Promise<ToolDefinition | null> {
    const parsed = parseQualifiedName(toolName)

    if (parsed) {
      return this.resolveQualified(parsed.serverSlug, parsed.toolName)
    }

    return this.resolveUnqualified(toolName, agentId, agentConfig)
  }

  /**
   * Resolve all MCP tools available to an agent.
   *
   * Filters:
   *  - mcp_server.status = 'ACTIVE'
   *  - mcp_server_tool.status = 'available'
   *  - agent_scope includes agentId (or scope is empty → all agents)
   *  - qualified name matches allowedTools (exact or glob)
   *  - denied tools take precedence over allowed
   */
  async resolveAll(
    agentId: string,
    allowedTools: string[],
    deniedTools: string[],
  ): Promise<ToolDefinition[]> {
    const cacheKey = `resolveAll:${agentId}:${allowedTools.join(",")}:${deniedTools.join(",")}`
    const cached = this.getCache<ToolDefinition[]>(cacheKey)
    if (cached !== undefined) return cached

    const rows = await this.fetchActiveTools()

    const results: ToolDefinition[] = []
    for (const { tool, server } of rows) {
      // Agent scope filter: empty scope means available to all agents
      const scope = server.agent_scope
      if (scope.length > 0 && !scope.includes(agentId)) continue

      const qName = qualifiedName(server.slug, tool.name)

      // Allow filter: tool must match at least one allowed pattern
      if (allowedTools.length > 0 && !matchesAnyGlob(qName, allowedTools)) continue

      // Deny filter: denied takes precedence
      if (deniedTools.length > 0 && matchesAnyGlob(qName, deniedTools)) continue

      results.push(createMcpToolDefinition(this.clientPool, server, tool))
    }

    this.setCache(cacheKey, results)
    return results
  }

  /** Invalidate the entire resolution cache. */
  invalidateCache(): void {
    this.cache.clear()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async resolveQualified(
    serverSlug: string,
    toolName: string,
  ): Promise<ToolDefinition | null> {
    const qName = qualifiedName(serverSlug, toolName)
    const cacheKey = `qualified:${qName}`
    const cached = this.getCache<ToolDefinition | null>(cacheKey)
    if (cached !== undefined) return cached

    const rows = await this.db
      .selectFrom("mcp_server_tool")
      .innerJoin("mcp_server", "mcp_server.id", "mcp_server_tool.mcp_server_id")
      .selectAll("mcp_server_tool")
      .select([
        "mcp_server.id as server_id",
        "mcp_server.name as server_name",
        "mcp_server.slug as server_slug",
        "mcp_server.transport as server_transport",
        "mcp_server.connection as server_connection",
        "mcp_server.agent_scope as server_agent_scope",
        "mcp_server.status as server_status",
        "mcp_server.description as server_description",
        "mcp_server.protocol_version as server_protocol_version",
        "mcp_server.server_info as server_server_info",
        "mcp_server.capabilities as server_capabilities",
        "mcp_server.health_probe_interval_ms as server_health_probe_interval_ms",
        "mcp_server.last_healthy_at as server_last_healthy_at",
        "mcp_server.error_message as server_error_message",
        "mcp_server.created_at as server_created_at",
        "mcp_server.updated_at as server_updated_at",
      ])
      .where("mcp_server.slug", "=", serverSlug)
      .where("mcp_server_tool.name", "=", toolName)
      .where("mcp_server.status", "=", "ACTIVE")
      .where("mcp_server_tool.status", "=", "available")
      .execute()

    if (rows.length === 0) {
      this.setCache(cacheKey, null)
      return null
    }

    const row = rows[0]
    const server = this.extractServer(row)
    const tool = this.extractTool(row)
    const def = createMcpToolDefinition(this.clientPool, server, tool)
    this.setCache(cacheKey, def)
    return def
  }

  private async resolveUnqualified(
    toolName: string,
    agentId: string,
    agentConfig?: Record<string, unknown>,
  ): Promise<ToolDefinition | null> {
    const cacheKey = `unqualified:${toolName}:${agentId}`
    const cached = this.getCache<ToolDefinition | null>(cacheKey)
    if (cached !== undefined) return cached

    const rows = await this.db
      .selectFrom("mcp_server_tool")
      .innerJoin("mcp_server", "mcp_server.id", "mcp_server_tool.mcp_server_id")
      .selectAll("mcp_server_tool")
      .select([
        "mcp_server.id as server_id",
        "mcp_server.name as server_name",
        "mcp_server.slug as server_slug",
        "mcp_server.transport as server_transport",
        "mcp_server.connection as server_connection",
        "mcp_server.agent_scope as server_agent_scope",
        "mcp_server.status as server_status",
        "mcp_server.description as server_description",
        "mcp_server.protocol_version as server_protocol_version",
        "mcp_server.server_info as server_server_info",
        "mcp_server.capabilities as server_capabilities",
        "mcp_server.health_probe_interval_ms as server_health_probe_interval_ms",
        "mcp_server.last_healthy_at as server_last_healthy_at",
        "mcp_server.error_message as server_error_message",
        "mcp_server.created_at as server_created_at",
        "mcp_server.updated_at as server_updated_at",
      ])
      .where("mcp_server_tool.name", "=", toolName)
      .where("mcp_server.status", "=", "ACTIVE")
      .where("mcp_server_tool.status", "=", "available")
      .orderBy("mcp_server.created_at", "asc")
      .execute()

    if (rows.length === 0) {
      this.setCache(cacheKey, null)
      return null
    }

    // Single match — no conflict
    if (rows.length === 1) {
      const row = rows[0]
      const def = createMcpToolDefinition(
        this.clientPool,
        this.extractServer(row),
        this.extractTool(row),
      )
      this.setCache(cacheKey, def)
      return def
    }

    // Multiple matches — conflict resolution
    const resolved = this.resolveConflict(rows, agentId, agentConfig)
    this.setCache(cacheKey, resolved)
    return resolved
  }

  /**
   * Conflict resolution for unqualified names with multiple matches.
   *
   * Priority order:
   *  1. Agent scope — prefer servers that include this agent in agent_scope
   *  2. Agent preference — mcp_preferences.server_priority ordering
   *  3. First registered — already sorted by created_at ASC
   *  4. Ambiguity error
   */
  private resolveConflict(
    rows: Array<Record<string, unknown>>,
    agentId: string,
    agentConfig?: Record<string, unknown>,
  ): ToolDefinition {
    // Step 1: filter by agent_scope
    const scopeFiltered = rows.filter((r) => {
      const scope = r.server_agent_scope as string[]
      return scope.length > 0 && scope.includes(agentId)
    })

    if (scopeFiltered.length === 1) {
      const row = scopeFiltered[0]
      return createMcpToolDefinition(
        this.clientPool,
        this.extractServer(row),
        this.extractTool(row),
      )
    }

    // Use scope-filtered list if any matches, otherwise fall back to all
    const candidates = scopeFiltered.length > 0 ? scopeFiltered : rows

    // Step 2: agent preference (mcp_preferences.server_priority)
    const priority = this.getServerPriority(agentConfig)
    if (priority.length > 0) {
      for (const slug of priority) {
        const match = candidates.find((r) => r.server_slug === slug)
        if (match) {
          return createMcpToolDefinition(
            this.clientPool,
            this.extractServer(match),
            this.extractTool(match),
          )
        }
      }
    }

    // Step 3: first registered (already ordered by created_at ASC)
    // Only use this if there's a clear winner — multiple candidates with
    // different created_at timestamps, take the earliest.
    const first = candidates[0]
    const second = candidates[1]
    const firstCreatedAt = first.server_created_at as Date
    const secondCreatedAt = second.server_created_at as Date

    if (firstCreatedAt.getTime() !== secondCreatedAt.getTime()) {
      return createMcpToolDefinition(
        this.clientPool,
        this.extractServer(first),
        this.extractTool(first),
      )
    }

    // Step 4: ambiguity error
    const toolName = first.name as string
    const serverSlugs = candidates.map((r) => r.server_slug as string)
    const qualifiedOptions = serverSlugs.map((s) => `mcp:${s}:${toolName}`).join(", ")
    throw new Error(
      `Ambiguous tool name "${toolName}": available from multiple MCP servers. ` +
        `Use a qualified name: ${qualifiedOptions}`,
    )
  }

  private getServerPriority(agentConfig?: Record<string, unknown>): string[] {
    if (!agentConfig) return []
    const prefs = agentConfig.mcp_preferences as Record<string, unknown> | undefined
    if (!prefs) return []
    const priority = prefs.server_priority
    if (!Array.isArray(priority)) return []
    return priority.filter((p): p is string => typeof p === "string")
  }

  /** Fetch all active tools joined with their servers. */
  private async fetchActiveTools(): Promise<ToolWithServer[]> {
    const cacheKey = "activeTools"
    const cached = this.getCache<ToolWithServer[]>(cacheKey)
    if (cached !== undefined) return cached

    const rows = await this.db
      .selectFrom("mcp_server_tool")
      .innerJoin("mcp_server", "mcp_server.id", "mcp_server_tool.mcp_server_id")
      .selectAll("mcp_server_tool")
      .select([
        "mcp_server.id as server_id",
        "mcp_server.name as server_name",
        "mcp_server.slug as server_slug",
        "mcp_server.transport as server_transport",
        "mcp_server.connection as server_connection",
        "mcp_server.agent_scope as server_agent_scope",
        "mcp_server.status as server_status",
        "mcp_server.description as server_description",
        "mcp_server.protocol_version as server_protocol_version",
        "mcp_server.server_info as server_server_info",
        "mcp_server.capabilities as server_capabilities",
        "mcp_server.health_probe_interval_ms as server_health_probe_interval_ms",
        "mcp_server.last_healthy_at as server_last_healthy_at",
        "mcp_server.error_message as server_error_message",
        "mcp_server.created_at as server_created_at",
        "mcp_server.updated_at as server_updated_at",
      ])
      .where("mcp_server.status", "=", "ACTIVE")
      .where("mcp_server_tool.status", "=", "available")
      .orderBy("mcp_server.created_at", "asc")
      .execute()

    const results: ToolWithServer[] = rows.map((row) => ({
      tool: this.extractTool(row),
      server: this.extractServer(row),
    }))

    this.setCache(cacheKey, results)
    return results
  }

  // -------------------------------------------------------------------------
  // Row extraction helpers
  // -------------------------------------------------------------------------

  private extractServer(row: Record<string, unknown>): McpServer {
    return {
      id: row.server_id as string,
      name: row.server_name as string,
      slug: row.server_slug as string,
      transport: row.server_transport,
      connection: row.server_connection,
      agent_scope: row.server_agent_scope,
      status: row.server_status,
      description: row.server_description,
      protocol_version: row.server_protocol_version,
      server_info: row.server_server_info,
      capabilities: row.server_capabilities,
      health_probe_interval_ms: row.server_health_probe_interval_ms,
      last_healthy_at: row.server_last_healthy_at,
      error_message: row.server_error_message,
      created_at: row.server_created_at,
      updated_at: row.server_updated_at,
    } as McpServer
  }

  private extractTool(row: Record<string, unknown>): McpServerTool {
    return {
      id: row.id as string,
      mcp_server_id: row.mcp_server_id as string,
      name: row.name as string,
      qualified_name: row.qualified_name as string,
      description: row.description as string | null,
      input_schema: row.input_schema as Record<string, unknown>,
      annotations: row.annotations as Record<string, unknown> | null,
      status: row.status as string,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as McpServerTool
  }

  // -------------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------------

  private getCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    return entry.value as T
  }

  private setCache(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  }
}
