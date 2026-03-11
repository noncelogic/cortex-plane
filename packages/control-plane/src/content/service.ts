import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { ContentItem, ContentItemType, ContentStatus, Database } from "../db/types.js"

export interface ContentServiceDeps {
  db: Kysely<Database>
}

export interface CreateContentInput {
  agentId: string
  title: string
  body?: string
  type?: ContentItemType
  metadata?: Record<string, unknown>
}

export interface ListContentFilters {
  status?: ContentStatus
  type?: ContentItemType
  agentId?: string
  limit?: number
  offset?: number
}

export class ContentService {
  private readonly db: Kysely<Database>

  constructor(deps: ContentServiceDeps) {
    this.db = deps.db
  }

  async create(input: CreateContentInput): Promise<ContentItem> {
    return this.db
      .insertInto("content_item")
      .values({
        agent_id: input.agentId,
        title: input.title,
        body: input.body ?? "",
        type: input.type ?? "blog",
        metadata: input.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async get(id: string): Promise<ContentItem | undefined> {
    return this.db.selectFrom("content_item").selectAll().where("id", "=", id).executeTakeFirst()
  }

  async list(filters: ListContentFilters = {}): Promise<{ items: ContentItem[]; total: number }> {
    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    let q = this.db.selectFrom("content_item").selectAll()
    let countQ = this.db.selectFrom("content_item").select(sql<number>`count(*)::int`.as("total"))

    if (filters.status) {
      q = q.where("status", "=", filters.status)
      countQ = countQ.where("status", "=", filters.status)
    }
    if (filters.type) {
      q = q.where("type", "=", filters.type)
      countQ = countQ.where("type", "=", filters.type)
    }
    if (filters.agentId) {
      q = q.where("agent_id", "=", filters.agentId)
      countQ = countQ.where("agent_id", "=", filters.agentId)
    }

    const [items, countRow] = await Promise.all([
      q.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
      countQ.executeTakeFirstOrThrow(),
    ])

    return { items, total: countRow.total }
  }

  async publish(id: string, channel?: string): Promise<ContentItem | undefined> {
    const now = new Date()
    const patch: Record<string, unknown> = {
      status: "PUBLISHED" as ContentStatus,
      published_at: now,
      updated_at: now,
    }
    if (channel !== undefined) {
      patch.channel = channel
    }

    return this.db
      .updateTable("content_item")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  async archive(id: string): Promise<ContentItem | undefined> {
    const now = new Date()
    return this.db
      .updateTable("content_item")
      .set({
        status: "ARCHIVED" as ContentStatus,
        archived_at: now,
        updated_at: now,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }
}
