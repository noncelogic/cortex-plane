import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { dashboardRoutes } from "../routes/dashboard.js"

const JOB_UUID = "00000000-0000-4000-8000-000000000001"
const AGENT_UUID = "00000000-0000-4000-8000-000000000002"
const SCREENSHOT_UUID = "00000000-0000-4000-8000-000000000010"
const EVENT_UUID = "00000000-0000-4000-8000-000000000011"

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_UUID,
    agent_id: AGENT_UUID,
    agent_name: "Agent One",
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
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: null,
    tool_call_count: 0,
    llm_call_count: 0,
    parent_job_id: null,
    delegation_depth: 0,
    count: 1,
    ...overrides,
  }
}

function mockDb(
  jobOverrides: Record<string, unknown> = {},
  agentEventRows: Record<string, unknown>[] = [],
  opts: {
    screenshotRows?: Record<string, unknown>[]
    browserEventRows?: Record<string, unknown>[]
  } = {},
) {
  const jobs = [makeJob(jobOverrides)]
  const screenshotRows = opts.screenshotRows ?? []
  const browserEventRows = opts.browserEventRows ?? []
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
    const executeTakeFirstOrThrow = vi
      .fn()
      .mockImplementation(() =>
        rows[0] ? Promise.resolve(rows[0]) : Promise.reject(new Error("no result")),
      )
    const execute = vi.fn().mockResolvedValue(rows)
    const terminal = { execute, executeTakeFirst, executeTakeFirstOrThrow }
    const offset = vi.fn().mockReturnValue(terminal)
    const limit = vi.fn().mockReturnValue({ ...terminal, offset })
    const orderBy = vi.fn().mockReturnValue({ ...terminal, limit, offset })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    const selectFn = vi
      .fn()
      .mockReturnValue({ where: whereFn, orderBy, limit, offset, ...terminal })
    whereFn.mockReturnValue({
      where: whereFn,
      select: selectFn,
      orderBy,
      limit,
      offset,
      ...terminal,
    })
    const selectAll = vi
      .fn()
      .mockReturnValue({ where: whereFn, orderBy, limit, offset, ...terminal })
    const chainRoot = { selectAll, select: selectFn, where: whereFn }
    const leftJoin = vi.fn().mockReturnValue(chainRoot)
    return { ...chainRoot, leftJoin }
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
      if (table === "agent") return selectChain([{ id: AGENT_UUID, name: "Agent One", count: 1 }])
      if (table === "agent_event") return selectChain(agentEventRows)
      if (table === "memory_extract_message") return selectChain(memoryRows)
      if (table === "approval_request")
        return selectChain([
          {
            count: 0,
            id: "ar-1",
            approval_status: "PENDING",
            action_type: "tool_call",
            requested_at: new Date("2026-02-26T00:00:00.000Z"),
            agent_name: null,
          },
        ])
      if (table === "browser_screenshot") return selectChain(screenshotRows)
      if (table === "browser_event") return selectChain(browserEventRows)
      return selectChain([])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      if (table === "job") return updateChain()
      return updateChain()
    }),
  } as unknown as Kysely<Database>
}

async function buildTestApp(
  jobOverrides: Record<string, unknown> = {},
  agentEventRows: Record<string, unknown>[] = [],
  opts: {
    screenshotRows?: Record<string, unknown>[]
    browserEventRows?: Record<string, unknown>[]
  } = {},
) {
  const app = Fastify({ logger: false })
  const db = mockDb(jobOverrides, agentEventRows, opts)

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
      contentService: {
        list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        publish: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
      } as never,
    }),
  )

  return { app }
}

async function buildTestAppWithSync(memorySyncService: { sync: ReturnType<typeof vi.fn> }) {
  const app = Fastify({ logger: false })
  const db = mockDb()

  await app.register(
    dashboardRoutes({
      db,
      enqueueJob: vi.fn().mockResolvedValue(undefined),
      observationService: {
        getStreamStatus: vi.fn().mockResolvedValue(null),
        listTabs: vi.fn().mockResolvedValue(null),
      } as never,
      contentService: {
        list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        publish: vi.fn().mockResolvedValue(undefined),
        archive: vi.fn().mockResolvedValue(undefined),
      } as never,
      memorySyncService: memorySyncService as never,
    }),
  )

  return { app }
}

describe("dashboard routes", () => {
  it("lists jobs in dashboard schema shape", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/jobs?limit=10&offset=0" })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(Array.isArray(body.jobs)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.jobs[0]).toMatchObject({
      id: JOB_UUID,
      agentId: AGENT_UUID,
      agentName: "Agent One",
      status: "FAILED",
      type: "research",
      error: "boom",
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.pagination).toBeDefined()
  })

  it("returns job detail with failureReason and attempt info", async () => {
    const { app } = await buildTestApp({
      error: {
        message: "context budget exceeded",
        category: "CONTEXT_BUDGET_EXCEEDED",
        provider: "google-antigravity",
        model: "claude-sonnet-4-6",
      },
      attempt: 2,
      max_attempts: 3,
    })

    const detail = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      id: JOB_UUID,
      agentId: AGENT_UUID,
      failureReason: {
        message: "context budget exceeded",
        category: "CONTEXT_BUDGET_EXCEEDED",
        provider: "google-antigravity",
        model: "claude-sonnet-4-6",
      },
      attempt: 2,
      maxAttempts: 3,
    })
  })

  it("falls back to result.error when job.error is missing", async () => {
    const { app } = await buildTestApp({
      error: null,
      result: {
        taskId: JOB_UUID,
        status: "failed",
        error: {
          message: "Provider endpoint/model mismatch",
          category: "PERMANENT",
          provider: "google-antigravity",
          model: "claude-sonnet-4-6-20250514",
        },
      },
    })

    const detail = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      failureReason: {
        message: "Provider endpoint/model mismatch",
        category: "PERMANENT",
        provider: "google-antigravity",
        model: "claude-sonnet-4-6-20250514",
      },
    })
  })

  it("synthesizes steps and logs from agent_event when result is empty", async () => {
    const events = [
      {
        event_type: "state_transition",
        payload: { from: "SCHEDULED", to: "RUNNING" },
        created_at: new Date("2026-02-26T00:00:10.000Z"),
        duration_ms: null,
        tool_ref: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
      },
      {
        event_type: "tool_call_end",
        payload: {},
        created_at: new Date("2026-02-26T00:00:20.000Z"),
        duration_ms: 500,
        tool_ref: "web_search",
        model: null,
        tokens_in: null,
        tokens_out: null,
      },
      {
        event_type: "error",
        payload: { message: "Rate limit hit" },
        created_at: new Date("2026-02-26T00:00:30.000Z"),
        duration_ms: null,
        tool_ref: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
      },
    ]

    const { app } = await buildTestApp({}, events)

    const detail = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(detail.statusCode).toBe(200)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = detail.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.steps).toHaveLength(3)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.steps[0]).toMatchObject({ name: "State → RUNNING", status: "COMPLETED" })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.steps[1]).toMatchObject({
      name: "Tool: web_search",
      status: "COMPLETED",
      durationMs: 500,
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.steps[2]).toMatchObject({
      name: "Rate limit hit",
      status: "FAILED",
      error: "Rate limit hit",
    })

    // Logs synthesized from the same events
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.logs).toHaveLength(3)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.logs[2]).toMatchObject({ level: "ERR", message: "Rate limit hit" })
  })

  it("returns empty steps/logs when no events exist and shows no tokenUsage", async () => {
    const { app } = await buildTestApp({ error: null })

    const detail = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      id: JOB_UUID,
      steps: [],
      logs: [],
    })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(detail.json().failureReason).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(detail.json().tokenUsage).toBeUndefined()
  })

  it("returns tokenUsage when job has execution stats", async () => {
    const { app } = await buildTestApp({
      tokens_in: 1200,
      tokens_out: 350,
      cost_usd: "0.0042",
      llm_call_count: 3,
      tool_call_count: 5,
    })

    const detail = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({
      tokenUsage: {
        tokensIn: 1200,
        tokensOut: 350,
        costUsd: 0.0042,
        llmCallCount: 3,
        toolCallCount: 5,
      },
    })
  })

  it("returns retry response", async () => {
    const { app } = await buildTestApp()

    const retry = await app.inject({ method: "POST", url: `/jobs/${JOB_UUID}/retry` })
    expect(retry.statusCode).toBe(202)
    expect(retry.json()).toEqual({ jobId: JOB_UUID, status: "retrying" })
  })

  it("rejects non-UUID jobId with 400", async () => {
    const { app } = await buildTestApp()

    // "not-a-uuid" is not a valid UUID, so /jobs/:jobId returns 400
    const bad = await app.inject({ method: "GET", url: "/jobs/not-a-uuid" })
    expect(bad.statusCode).toBe(400)
  })

  it("serves content list, memory search, and browser endpoints", async () => {
    const { app } = await buildTestApp()

    const content = await app.inject({ method: "GET", url: "/content" })
    expect(content.statusCode).toBe(200)
    expect(content.json()).toEqual({
      content: [],
      pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
    })

    const memory = await app.inject({
      method: "GET",
      url: "/memory/search?agentId=agent-1&query=kubernetes",
    })
    expect(memory.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(memory.json().results[0]).toMatchObject({
      id: "mem-1",
      type: "fact",
      source: "session:sess-1",
    })

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

  it("returns dashboard summary with aggregated counts", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/dashboard/summary" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      totalAgents: 1,
      activeJobs: 1,
      pendingApprovals: 0,
      memoryRecords: 0,
      trends: {
        totalAgents24h: 1,
        activeJobs24h: 1,
        pendingApprovals24h: 0,
        memoryRecords24h: 0,
      },
    })
  })

  it("returns dashboard activity with recent jobs", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/dashboard/activity?limit=5" })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(Array.isArray(body.activity)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.activity[0]).toMatchObject({
      id: JOB_UUID,
      agentId: AGENT_UUID,
      status: "FAILED",
      type: "research",
    })
  })

  it("returns 404 for publish/archive on non-existent content", async () => {
    const { app } = await buildTestApp()

    const publish = await app.inject({
      method: "POST",
      url: "/content/c-1/publish",
      payload: { channel: "website" },
    })
    expect(publish.statusCode).toBe(404)
    expect(publish.json()).toEqual({
      error: "not_found",
      message: "Content item not found",
    })

    const archive = await app.inject({ method: "POST", url: "/content/c-1/archive" })
    expect(archive.statusCode).toBe(404)
    expect(archive.json()).toEqual({
      error: "not_found",
      message: "Content item not found",
    })
  })

  it("returns persisted screenshots from database", async () => {
    const { app } = await buildTestApp({}, [], {
      screenshotRows: [
        {
          id: SCREENSHOT_UUID,
          agent_id: AGENT_UUID,
          thumbnail_url: "/thumbs/shot1.jpg",
          full_url: "/shots/shot1.png",
          width: 1920,
          height: 1080,
          created_at: new Date("2026-03-10T12:00:00.000Z"),
        },
      ],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_UUID}/browser/screenshots`,
    })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.screenshots).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.screenshots[0]).toMatchObject({
      id: SCREENSHOT_UUID,
      agentId: AGENT_UUID,
      thumbnailUrl: "/thumbs/shot1.jpg",
      fullUrl: "/shots/shot1.png",
      dimensions: { width: 1920, height: 1080 },
    })
  })

  it("returns persisted browser events from database", async () => {
    const { app } = await buildTestApp({}, [], {
      browserEventRows: [
        {
          id: EVENT_UUID,
          agent_id: AGENT_UUID,
          type: "NAVIGATE",
          url: "https://example.com",
          selector: null,
          message: null,
          duration_ms: 120,
          severity: "info",
          created_at: new Date("2026-03-10T12:01:00.000Z"),
        },
      ],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_UUID}/browser/events`,
    })
    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.events).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.events[0]).toMatchObject({
      id: EVENT_UUID,
      type: "NAVIGATE",
      url: "https://example.com",
      durationMs: 120,
      severity: "info",
    })
    // null fields should be omitted
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.events[0].selector).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.events[0].message).toBeUndefined()
  })

  it("returns empty arrays when no browser data exists", async () => {
    const { app } = await buildTestApp()

    const screenshots = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_UUID}/browser/screenshots`,
    })
    expect(screenshots.statusCode).toBe(200)
    expect(screenshots.json()).toEqual({ screenshots: [] })

    const events = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_UUID}/browser/events`,
    })
    expect(events.statusCode).toBe(200)
    expect(events.json()).toEqual({ events: [] })
  })

  it("returns 501 for memory sync when service is not configured", async () => {
    const { app } = await buildTestApp()

    const sync = await app.inject({
      method: "POST",
      url: "/memory/sync",
      payload: { agentId: "agent-1" },
    })
    expect(sync.statusCode).toBe(501)
    expect(sync.json()).toEqual({
      error: "not_implemented",
      message: "Memory sync is not yet implemented",
    })
  })

  it("returns sync stats when memorySyncService is provided", async () => {
    const mockSyncService = {
      sync: vi.fn().mockResolvedValue({ upserted: 3, deleted: 1, unchanged: 5 }),
    }
    const { app } = await buildTestAppWithSync(mockSyncService)

    const sync = await app.inject({
      method: "POST",
      url: "/memory/sync",
      payload: { agentId: "agent-1" },
    })
    expect(sync.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = sync.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("completed")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.stats).toEqual({ upserted: 3, deleted: 1, unchanged: 5 })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.sync_id).toMatch(/^sync_agent-1_\d+$/)
    expect(mockSyncService.sync).toHaveBeenCalledWith("agent-1")
  })

  it("returns 404 when agent is not found during sync", async () => {
    const err = new Error("Agent not found: bad-id")
    err.name = "AgentNotFoundError"
    const mockSyncService = {
      sync: vi.fn().mockRejectedValue(err),
    }
    const { app } = await buildTestAppWithSync(mockSyncService)

    const sync = await app.inject({
      method: "POST",
      url: "/memory/sync",
      payload: { agentId: "bad-id" },
    })
    expect(sync.statusCode).toBe(404)
    expect(sync.json()).toEqual({
      error: "not_found",
      message: "Agent not found: bad-id",
    })
  })
})
