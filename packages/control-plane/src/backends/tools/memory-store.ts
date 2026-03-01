/**
 * Built-in memory_store tool — stores content in the agent's memory.
 *
 * Writes a new memory point to Qdrant with payload metadata.
 * The vector embedding is left as a zero vector (to be updated by the
 * memory extraction pipeline or an embedding service).
 */

import { randomUUID } from "node:crypto"

import type { ToolDefinition } from "../tool-executor.js"

export interface MemoryStoreConfig {
  /** Qdrant HTTP endpoint. */
  qdrantUrl?: string
  /** Qdrant API key. */
  qdrantApiKey?: string
  /** Collection name. */
  collection?: string
  /** Embedding vector dimension (must match collection config). */
  vectorSize?: number
}

const DEFAULT_COLLECTION = "agent_memories"
const DEFAULT_VECTOR_SIZE = 1536

export function createMemoryStoreTool(config?: MemoryStoreConfig): ToolDefinition {
  const qdrantUrl = config?.qdrantUrl ?? process.env.QDRANT_URL ?? "http://localhost:6333"
  const qdrantApiKey = config?.qdrantApiKey ?? process.env.QDRANT_API_KEY
  const collection = config?.collection ?? DEFAULT_COLLECTION
  const vectorSize = config?.vectorSize ?? DEFAULT_VECTOR_SIZE

  return {
    name: "memory_store",
    description:
      "Store a piece of information in the agent's long-term memory for later retrieval. Use this to remember important facts, decisions, or context.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text content to store in memory" },
        metadata: {
          type: "object",
          description:
            "Optional metadata tags (e.g. { topic: 'architecture', importance: 'high' })",
        },
      },
      required: ["content"],
    },
    execute: async (input) => {
      const content = typeof input.content === "string" ? input.content : String(input.content)
      const metadata =
        typeof input.metadata === "object" && input.metadata !== null
          ? (input.metadata as Record<string, unknown>)
          : {}

      const pointId = randomUUID()
      const now = new Date().toISOString()

      const body = {
        points: [
          {
            id: pointId,
            vector: new Array(vectorSize).fill(0) as number[],
            payload: {
              content,
              metadata,
              created_at: now,
            },
          },
        ],
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }
      if (qdrantApiKey) {
        headers["api-key"] = qdrantApiKey
      }

      const url = `${qdrantUrl}/collections/${encodeURIComponent(collection)}/points?wait=true`

      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        return JSON.stringify({
          error: `Memory store failed: ${response.status} ${response.statusText}`,
        })
      }

      return JSON.stringify({
        stored: true,
        id: pointId,
        content: content.slice(0, 100) + (content.length > 100 ? "..." : ""),
      })
    },
  }
}
