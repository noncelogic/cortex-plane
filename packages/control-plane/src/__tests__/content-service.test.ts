import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import { ContentService } from "../content/service.js"
import type { ContentItem, Database } from "../db/types.js"
import { dashboardRoutes } from "../routes/dashboard.js"

const CONTENT_UUID = "00000000-0000-4000-8000-000000000010"
const AGENT_UUID = "00000000-0000-4000-8000-000000000002"

function makeContentItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: CONTENT_UUID,
    agent_id: AGENT_UUID,
    title: "Test Article",
    body: "Hello world",
    type: "blog",
    status: "DRAFT",
    channel: null,
    metadata: {},
    published_at: null,
    archived_at: null,
    created_at: new Date("2026-03-10T00:00:00.000Z"),
    updated_at: new Date("2026-03-10T00:00:00.000Z"),
    ...overrides,
  }
}

// -------------------------------------------------------------------------
// Unit tests: ContentService with mocked Kysely
// -------------------------------------------------------------------------

describe("ContentService", () => {
  function buildMockDb() {
    const executeTakeFirstOrThrow = vi.fn()
    const executeTakeFirst = vi.fn()
    const execute = vi.fn()

    const insertTerminal = {
      returningAll: vi.fn().mockReturnValue({ executeTakeFirstOrThrow }),
    }
    const insertValues = vi.fn().mockReturnValue(insertTerminal)
    const insertInto = vi.fn().mockReturnValue({ values: insertValues })

    const selectWhere: ReturnType<typeof vi.fn> = vi.fn()
    const selectOffset = vi.fn().mockReturnValue({ execute })
    const selectLimit = vi.fn().mockReturnValue({ offset: selectOffset, execute })
    const selectOrderBy = vi
      .fn()
      .mockReturnValue({ limit: selectLimit, offset: selectOffset, execute })
    selectWhere.mockReturnValue({
      where: selectWhere,
      orderBy: selectOrderBy,
      limit: selectLimit,
      offset: selectOffset,
      execute,
      executeTakeFirst,
      executeTakeFirstOrThrow,
      select: vi.fn().mockReturnValue({ executeTakeFirstOrThrow }),
    })
    const selectAll = vi.fn().mockReturnValue({
      where: selectWhere,
      orderBy: selectOrderBy,
      limit: selectLimit,
      execute,
      executeTakeFirst,
    })
    const selectFn = vi.fn().mockReturnValue({
      where: selectWhere,
      executeTakeFirstOrThrow,
    })
    const selectFrom = vi.fn().mockReturnValue({ selectAll, select: selectFn })

    const updateReturningAll = vi.fn().mockReturnValue({ executeTakeFirst })
    const updateWhere = vi
      .fn()
      .mockReturnValue({ returningAll: updateReturningAll, executeTakeFirst })
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
    const updateTable = vi.fn().mockReturnValue({ set: updateSet })

    const fn = { countAll: vi.fn().mockReturnValue({ as: vi.fn() }) }

    const db = { insertInto, selectFrom, updateTable, fn } as unknown as Kysely<Database>

    return {
      db,
      executeTakeFirstOrThrow,
      executeTakeFirst,
      execute,
    }
  }

  it("create inserts and returns content item", async () => {
    const { db, executeTakeFirstOrThrow } = buildMockDb()
    const item = makeContentItem()
    executeTakeFirstOrThrow.mockResolvedValue(item)

    const svc = new ContentService({ db })
    const result = await svc.create({
      agentId: AGENT_UUID,
      title: "Test Article",
      body: "Hello world",
      type: "blog",
    })

    expect(result).toEqual(item)
  })

  it("get returns a single content item", async () => {
    const { db, executeTakeFirst } = buildMockDb()
    const item = makeContentItem()
    executeTakeFirst.mockResolvedValue(item)

    const svc = new ContentService({ db })
    const result = await svc.get(CONTENT_UUID)
    expect(result).toEqual(item)
  })

  it("publish updates status and published_at", async () => {
    const { db, executeTakeFirst } = buildMockDb()
    const published = makeContentItem({ status: "PUBLISHED", published_at: new Date() })
    executeTakeFirst.mockResolvedValue(published)

    const svc = new ContentService({ db })
    const result = await svc.publish(CONTENT_UUID, "website")
    expect(result?.status).toBe("PUBLISHED")
  })

  it("archive updates status and archived_at", async () => {
    const { db, executeTakeFirst } = buildMockDb()
    const archived = makeContentItem({ status: "ARCHIVED", archived_at: new Date() })
    executeTakeFirst.mockResolvedValue(archived)

    const svc = new ContentService({ db })
    const result = await svc.archive(CONTENT_UUID)
    expect(result?.status).toBe("ARCHIVED")
  })

  it("publish returns undefined for non-existent item", async () => {
    const { db, executeTakeFirst } = buildMockDb()
    executeTakeFirst.mockResolvedValue(undefined)

    const svc = new ContentService({ db })
    const result = await svc.publish("nonexistent")
    expect(result).toBeUndefined()
  })
})

// -------------------------------------------------------------------------
// Integration tests: content routes through Fastify
// -------------------------------------------------------------------------

describe("content dashboard routes", () => {
  function buildContentService(overrides: Partial<ContentService> = {}) {
    return {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      create: vi.fn(),
      get: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as ContentService
  }

  function stubDb() {
    const terminal = {
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue(null),
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ count: 0 }),
    }
    const chain = {
      ...terminal,
      where: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
    }
    return {
      selectFrom: vi.fn().mockReturnValue(chain),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(terminal),
        }),
      }),
    } as unknown as Kysely<Database>
  }

  async function buildApp(contentService: ContentService) {
    const app = Fastify({ logger: false })
    await app.register(
      dashboardRoutes({
        db: stubDb(),
        enqueueJob: vi.fn().mockResolvedValue(undefined),
        observationService: {
          getStreamStatus: vi.fn().mockResolvedValue(null),
          listTabs: vi.fn().mockResolvedValue(null),
        } as never,
        contentService,
      }),
    )
    return app
  }

  it("GET /content returns list with pagination", async () => {
    const item = makeContentItem()
    const cs = buildContentService({
      list: vi.fn().mockResolvedValue({ items: [item], total: 1 }),
    } as never)
    const app = await buildApp(cs)

    const res = await app.inject({ method: "GET", url: "/content?status=DRAFT&limit=10&offset=0" })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.content).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.content[0]).toMatchObject({
      id: CONTENT_UUID,
      agentId: AGENT_UUID,
      title: "Test Article",
      status: "DRAFT",
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination).toEqual({ total: 1, limit: 10, offset: 0, hasMore: false })
  })

  it("GET /content returns hasMore when more items exist", async () => {
    const cs = buildContentService({
      list: vi.fn().mockResolvedValue({ items: [makeContentItem()], total: 100 }),
    } as never)
    const app = await buildApp(cs)

    const res = await app.inject({ method: "GET", url: "/content?limit=10&offset=0" })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().pagination.hasMore).toBe(true)
  })

  it("POST /content/:id/publish returns published item", async () => {
    const published = makeContentItem({
      status: "PUBLISHED",
      published_at: new Date("2026-03-11T12:00:00.000Z"),
    })
    const cs = buildContentService({
      publish: vi.fn().mockResolvedValue(published),
    } as never)
    const app = await buildApp(cs)

    const res = await app.inject({
      method: "POST",
      url: `/content/${CONTENT_UUID}/publish`,
      payload: { channel: "website" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: CONTENT_UUID,
      status: "PUBLISHED",
      publishedAt: "2026-03-11T12:00:00.000Z",
    })
  })

  it("POST /content/:id/publish returns 404 for missing item", async () => {
    const cs = buildContentService()
    const app = await buildApp(cs)

    const res = await app.inject({
      method: "POST",
      url: "/content/nonexistent/publish",
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "not_found", message: "Content item not found" })
  })

  it("POST /content/:id/archive returns archived item", async () => {
    const archived = makeContentItem({
      status: "ARCHIVED",
      archived_at: new Date("2026-03-11T13:00:00.000Z"),
    })
    const cs = buildContentService({
      archive: vi.fn().mockResolvedValue(archived),
    } as never)
    const app = await buildApp(cs)

    const res = await app.inject({
      method: "POST",
      url: `/content/${CONTENT_UUID}/archive`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: CONTENT_UUID,
      status: "ARCHIVED",
    })
  })

  it("POST /content/:id/archive returns 404 for missing item", async () => {
    const cs = buildContentService()
    const app = await buildApp(cs)

    const res = await app.inject({ method: "POST", url: "/content/nonexistent/archive" })
    expect(res.statusCode).toBe(404)
  })
})
