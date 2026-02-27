import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { dashboardRoutes } from "../routes/dashboard.js"

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    agent_id: "agent-1",
    session_id: null,
    status: "FAILED",
    priority: 0,
    payload: { goal_type: "research" },
    result: null,
    checkpoint: null,
    checkpoint_crc: null,
    error: { message: "boom" },
    attempt: 1,
    max_attempts: 3,
    timeout_seconds: 300,
    created_at: new Date("2026-02-26T00:00:00.000Z"),
    updated_at: new Date("2026-02-26T00:01:00.000Z"),
    started_at: null,
    completed_at: null,
    heartbeat_at: null,
    approval_expires_at: null,
    ...overrides,
  }
}

function mockDb() {
  const jobs = [makeJob()]
  const memoryRows = [
    {
      id: "mem-1",
      session_id: "sess-1",
      agent_id: "agent-1",
      role: "assistant",
      content: "kubernetes deployment note",
      occurred_at: new Date("2026-02-26T00:02:00.000Z"),
      extracted_at: null,
      created_at: new Date("2026-02-26T00:02:00.000Z"),
    },
  ]

  function selectChain(rows: Record<string, unknown>[]) {
    const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
    const execute = vi.fn().mockResolvedValue(rows)
    const terminal = { execute, executeTakeFirst }
    const offset = vi.fn().mockReturnValue(terminal)
    const limit = vi.fn().mockReturnValue({ ...terminal, offset })
    const orderBy = vi.fn().mockReturnValue({ ...terminal, limit, offset })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({
      where: whereFn,
      orderBy,
      limit,
      offset,
      ...terminal,
    })
    const selectAll = vi
      .fn()
      .mockReturnValue({ where: whereFn, orderBy, limit, offset, ...terminal })
    const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
    return { selectAll, select }
  }

  function updateChain() {
    const execute = vi.fn().mockResolvedValue([])
    const where = vi.fn().mockReturnValue({ execute })
    const set = vi.fn().mockReturnValue({ where })
    return { set }
  }

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "job") return selectChain(jobs)
      if (table === "agent") return selectChain([{ id: "agent-1", name: "Agent One" }])
      if (table === "memory_extract_message") return selectChain(memoryRows)
      return selectChain([])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      if (table === "job") return updateChain()
      return updateChain()
    }),
  } as unknown as Kysely<Database>
}

async function buildTestApp() {
  const app = Fastify({ logger: false })
  const db = mockDb()

  await app.register(
    dashboardRoutes({
      db,
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      observationService: {
        getStreamStatus: vi.fn().mockResolvedValue({
          agentId: "agent-1",
          quality: "live",
          fps: 30,
          lastFrameAt: null,
          vncEndpoint: {
            websocketUrl: "ws://127.0.0.1:6080",
            vncAddress: "127.0.0.1:5900",
            available: true,
          },
        }),
        listTabs: vi.fn().mockResolvedValue({
          agentId: "agent-1",
          tabs: [{ index: 0, url: "https://example.com", title: "Example", active: true }],
          timestamp: new Date().toISOString(),
        }),
      } as never,
    }),
  )

  return { app }
}

describe("dashboard routes", () => {
  it("lists jobs in dashboard schema shape", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/jobs?limit=10&offset=0" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.jobs)).toBe(true)
    expect(body.jobs[0]).toMatchObject({
      id: "job-1",
      agentId: "agent-1",
      status: "FAILED",
      type: "research",
    })
    expect(body.pagination).toBeDefined()
  })

  it("returns job detail and retry response", async () => {
    const { app } = await buildTestApp()

    const detail = await app.inject({ method: "GET", url: "/jobs/job-1" })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      id: "job-1",
      agentId: "agent-1",
      steps: [],
      logs: [],
    })

    const retry = await app.inject({ method: "POST", url: "/jobs/job-1/retry" })
    expect(retry.statusCode).toBe(202)
    expect(retry.json()).toEqual({ jobId: "job-1", status: "retrying" })
  })

  it("serves content, memory, and browser endpoints", async () => {
    const { app } = await buildTestApp()

    const content = await app.inject({ method: "GET", url: "/content" })
    expect(content.statusCode).toBe(200)
    expect(content.json()).toEqual({
      content: [],
      pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
    })

    const publish = await app.inject({
      method: "POST",
      url: "/content/c-1/publish",
      payload: { channel: "website" },
    })
    expect(publish.statusCode).toBe(200)
    expect(publish.json().contentId).toBe("c-1")
    expect(publish.json().status).toBe("published")

    const archive = await app.inject({ method: "POST", url: "/content/c-1/archive" })
    expect(archive.statusCode).toBe(200)
    expect(archive.json()).toEqual({ contentId: "c-1", status: "archived" })

    const memory = await app.inject({
      method: "GET",
      url: "/memory/search?agentId=agent-1&query=kubernetes",
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().results[0]).toMatchObject({
      id: "mem-1",
      type: "fact",
      source: "session:sess-1",
    })

    const sync = await app.inject({
      method: "POST",
      url: "/memory/sync",
      payload: { agentId: "agent-1" },
    })
    expect(sync.statusCode).toBe(200)
    expect(sync.json().status).toBe("completed")

    const browser = await app.inject({ method: "GET", url: "/agents/agent-1/browser" })
    expect(browser.statusCode).toBe(200)
    expect(browser.json()).toMatchObject({
      id: "browser-agent-1",
      agentId: "agent-1",
      status: "connected",
    })

    const screenshots = await app.inject({
      method: "GET",
      url: "/agents/agent-1/browser/screenshots",
    })
    expect(screenshots.statusCode).toBe(200)
    expect(screenshots.json()).toEqual({ screenshots: [] })

    const events = await app.inject({ method: "GET", url: "/agents/agent-1/browser/events" })
    expect(events.statusCode).toBe(200)
    expect(events.json()).toEqual({ events: [] })
  })
})
