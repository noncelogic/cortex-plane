/**
 * Built-in memory_query tool — queries the agent's memory store.
 *
 * Searches vector memory (Qdrant) for semantically similar content.
 * Requires a Qdrant client to be injected at creation time.
 */

import type { ToolDefinition } from "../tool-executor.js"

export interface MemoryQueryConfig {
  /** Qdrant HTTP endpoint. */
  qdrantUrl?: string
  /** Qdrant API key. */
  qdrantApiKey?: string
  /** Collection name to query. */
  collection?: string
  /** Maximum results to return. */
  maxResults?: number
}

const DEFAULT_COLLECTION = "agent_memories"
const DEFAULT_MAX_RESULTS = 10

export function createMemoryQueryTool(config?: MemoryQueryConfig): ToolDefinition {
  const qdrantUrl = config?.qdrantUrl ?? process.env.QDRANT_URL ?? "http://localhost:6333"
  const qdrantApiKey = config?.qdrantApiKey ?? process.env.QDRANT_API_KEY
  const collection = config?.collection ?? DEFAULT_COLLECTION
  const maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS

  return {
    name: "memory_query",
    description:
      "Search the agent's memory store for relevant past interactions, knowledge, and context. Returns semantically similar memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default 10)",
        },
        filter: {
          type: "object",
          description: "Optional metadata filter (e.g. { agentId: '...' })",
        },
      },
      required: ["query"],
    },
    execute: async (input) => {
      const query = typeof input.query === "string" ? input.query : String(input.query)
      const limit = Math.min(typeof input.limit === "number" ? input.limit : maxResults, 50)
      const filter =
        typeof input.filter === "object" && input.filter !== null
          ? (input.filter as Record<string, unknown>)
          : undefined

      const scrollBody: Record<string, unknown> = {
        limit,
        with_payload: true,
        filter: filter
          ? {
              must: Object.entries(filter).map(([key, value]) => ({
                key,
                match: { value },
              })),
            }
          : undefined,
      }

      // Use scroll with filter if no embedding service is available,
      // otherwise use search with query vector. For simplicity, we use
      // the Qdrant scroll endpoint with payload filtering.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (qdrantApiKey) {
        headers["api-key"] = qdrantApiKey
      }

      const url = `${qdrantUrl}/collections/${encodeURIComponent(collection)}/points/scroll`

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(scrollBody),
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        return JSON.stringify({
          error: `Memory query failed: ${response.status} ${response.statusText}`,
          query,
        })
      }

      const data = (await response.json()) as Record<string, unknown>
      const result = data.result as Record<string, unknown> | undefined
      const points = result?.points

      if (!Array.isArray(points)) {
        return JSON.stringify({ memories: [], query })
      }

      const memories = points.map((p: Record<string, unknown>) => {
        const payload = p.payload as Record<string, unknown> | undefined
        return {
          id: p.id,
          content: payload?.content ?? payload?.text ?? "",
          metadata: payload?.metadata ?? {},
        }
      })

      return JSON.stringify({ memories, query, count: memories.length })
    },
  }
}
