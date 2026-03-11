import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { batchImport, type EmbeddingFn, QdrantMemoryClient } from "@cortex/shared/memory"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

export interface MemorySyncServiceDeps {
  db: Kysely<Database>
  /** Root directory where per-agent memory folders are stored. */
  dataDir: string
  /** Function that embeds text chunks into vectors. */
  embeddingFn: EmbeddingFn
  /** Optional Qdrant connection options. */
  qdrantUrl?: string
  qdrantApiKey?: string
}

export interface SyncStats {
  upserted: number
  deleted: number
  unchanged: number
}

export class MemorySyncService {
  private readonly db: Kysely<Database>
  private readonly dataDir: string
  private readonly embeddingFn: EmbeddingFn
  private readonly qdrantUrl?: string
  private readonly qdrantApiKey?: string

  constructor(deps: MemorySyncServiceDeps) {
    this.db = deps.db
    this.dataDir = deps.dataDir
    this.embeddingFn = deps.embeddingFn
    this.qdrantUrl = deps.qdrantUrl
    this.qdrantApiKey = deps.qdrantApiKey
  }

  /**
   * Run a file→Qdrant sync for the given agent.
   * Reads markdown files from the agent's memory directory and upserts
   * their chunks into the agent's Qdrant collection.
   */
  async sync(agentId: string): Promise<SyncStats> {
    const agent = await this.db
      .selectFrom("agent")
      .select(["slug"])
      .where("id", "=", agentId)
      .executeTakeFirst()

    if (!agent) {
      throw new AgentNotFoundError(agentId)
    }

    const agentMemoryDir = join(this.dataDir, agent.slug, "memory")
    await mkdir(agentMemoryDir, { recursive: true })

    const qdrant = new QdrantMemoryClient(agent.slug, {
      url: this.qdrantUrl,
      apiKey: this.qdrantApiKey,
    })

    const { results } = await batchImport(
      agentMemoryDir,
      ["*.md", "**/*.md"],
      qdrant,
      this.embeddingFn,
    )

    let upserted = 0
    let deleted = 0
    let unchanged = 0

    for (const r of results.values()) {
      upserted += r.created + r.updated
      deleted += r.deleted
      unchanged += r.unchanged
    }

    return { upserted, deleted, unchanged }
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`)
    this.name = "AgentNotFoundError"
  }
}
