import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { dashboardRoutes } from "../routes/dashboard.js"

const JOB_UUID = "00000000-0000-4000-8000-000000000001"
const AGENT_UUID = "00000000-0000-4000-8000-000000000002"

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
) {
  const jobs = [makeJob(jobOverrides)]
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
      if (table === "approval_request") return selectChain([{ count: 0 }])
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
) {
  const app = Fastify({ logger: false })
  const db = mockDb(jobOverrides, agentEventRows)

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
      error: { message: "context budget exceeded", category: "CONTEXT_BUDGET_EXCEEDED" },
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
      },
      attempt: 2,
      maxAttempts: 3,
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

  it("returns 501 for stub endpoints not yet implemented", async () => {
    const { app } = await buildTestApp()

    const publish = await app.inject({
      method: "POST",
      url: "/content/c-1/publish",
      payload: { channel: "website" },
    })
    expect(publish.statusCode).toBe(501)
    expect(publish.json()).toEqual({
      error: "not_implemented",
      message: "Content publishing is not yet implemented",
    })

    const archive = await app.inject({ method: "POST", url: "/content/c-1/archive" })
    expect(archive.statusCode).toBe(501)
    expect(archive.json()).toEqual({
      error: "not_implemented",
      message: "Content archiving is not yet implemented",
    })

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
})
