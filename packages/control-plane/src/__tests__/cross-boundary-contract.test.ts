/**
 * Cross-Boundary Contract Tests
 *
 * Validates that actual route-handler responses parse against the dashboard
 * Zod schemas. This catches field renames, missing fields, type mismatches,
 * and enum drift that unit tests with toMatchObject() silently miss.
 *
 * Each test spins up real Fastify route handlers (with mocked DB/services),
 * calls actual endpoints, and asserts the response against the corresponding
 * dashboard schema. If the API shape drifts from what the dashboard expects,
 * these tests fail.
 *
 * See: https://github.com/noncelogic/cortex-plane/issues/669
 */

import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  RetryJobResponseSchema,
  SyncMemoryResponseSchema,
} from "../../../dashboard/src/lib/schemas/actions"
import {
  BrowserEventListResponseSchema,
  BrowserSessionSchema,
  ScreenshotListResponseSchema,
} from "../../../dashboard/src/lib/schemas/browser"
import { PaginationSchema } from "../../../dashboard/src/lib/schemas/common"
import { ContentListResponseSchema } from "../../../dashboard/src/lib/schemas/content"
import { ProviderListResponseSchema } from "../../../dashboard/src/lib/schemas/credentials"
// ---------------------------------------------------------------------------
// Dashboard Zod schemas — canonical source of truth for the UI
// ---------------------------------------------------------------------------
// We import directly from the dashboard package so that any schema change
// is immediately reflected in these tests without a manual sync step.
import {
  DashboardActivitySchema,
  DashboardSummarySchema,
} from "../../../dashboard/src/lib/schemas/jobs"
import { MemorySearchResponseSchema } from "../../../dashboard/src/lib/schemas/memory"
import { ModelListResponseSchema } from "../../../dashboard/src/lib/schemas/models"
import type { Database } from "../db/types.js"
import { dashboardRoutes } from "../routes/dashboard.js"

// ---------------------------------------------------------------------------
// Relaxed versions of schemas that accept supersets (route handlers may
// include extra fields the dashboard simply ignores). We use passthrough()
// to allow additional properties, then re-validate the strict shape.
// ---------------------------------------------------------------------------

/**
 * Parse a response against a dashboard Zod schema. Throws with a clear diff
 * if the response is missing required fields or has wrong types. Extra fields
 * returned by the API are allowed (passthrough) — the contract only cares that
 * the dashboard can parse the response.
 */
function assertMatchesSchema<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string) {
  const result = schema.safeParse(data)
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Contract violation in ${label}:\n${formatted}`)
  }
}

// ---------------------------------------------------------------------------
// Job list response schema (relaxed — costUsd may be missing)
// The dashboard JobSummarySchema expects costUsd as optional, so the base
// JobListResponseSchema already handles this.
// ---------------------------------------------------------------------------
import { JobDetailSchema, JobListResponseSchema } from "../../../dashboard/src/lib/schemas/jobs"

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock DB builder — same pattern as dashboard-routes.test.ts
// ---------------------------------------------------------------------------

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
    updateTable: vi.fn().mockImplementation((_table: string) => {
      return updateChain()
    }),
  } as unknown as Kysely<Database>
}

// ---------------------------------------------------------------------------
// Fastify test app builder
// ---------------------------------------------------------------------------

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
        getSession: vi.fn().mockReturnValue({
          agentId: "agent-1",
          status: "connected",
          sessionId: "session-agent-1",
          targetId: "target-agent-1",
          currentUrl: "https://example.com",
          currentTitle: "Example",
          errorMessage: null,
          lastHeartbeat: new Date().toISOString(),
        }),
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
        getSession: vi.fn().mockReturnValue({
          agentId: "agent-1",
          status: "disconnected",
          sessionId: null,
          targetId: null,
          currentUrl: null,
          currentTitle: null,
          errorMessage: null,
          lastHeartbeat: null,
        }),
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

// ===========================================================================
// Contract Tests: Dashboard Routes ↔ Dashboard Schemas
// ===========================================================================

describe("cross-boundary contract: dashboard routes → dashboard schemas", () => {
  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  it("GET /jobs response matches JobListResponseSchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/jobs?limit=10&offset=0" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(JobListResponseSchema, res.json(), "GET /jobs")
  })

  it("GET /jobs/:jobId response matches JobDetailSchema", async () => {
    const { app } = await buildTestApp({
      error: { message: "context budget exceeded", category: "CONTEXT_BUDGET_EXCEEDED" },
      attempt: 2,
      max_attempts: 3,
      tokens_in: 1200,
      tokens_out: 350,
      cost_usd: "0.0042",
      llm_call_count: 3,
      tool_call_count: 5,
    })
    const res = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(JobDetailSchema, res.json(), "GET /jobs/:jobId")
  })

  it("GET /jobs/:jobId with synthesized steps/logs matches JobDetailSchema", async () => {
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
    const res = await app.inject({ method: "GET", url: `/jobs/${JOB_UUID}` })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(JobDetailSchema, res.json(), "GET /jobs/:jobId (synthesized)")
  })

  it("POST /jobs/:jobId/retry response matches RetryJobResponseSchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "POST", url: `/jobs/${JOB_UUID}/retry` })
    expect(res.statusCode).toBe(202)
    assertMatchesSchema(RetryJobResponseSchema, res.json(), "POST /jobs/:jobId/retry")
  })

  // -------------------------------------------------------------------------
  // Dashboard aggregation
  // -------------------------------------------------------------------------

  it("GET /dashboard/summary response matches DashboardSummarySchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/dashboard/summary" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(DashboardSummarySchema, res.json(), "GET /dashboard/summary")
  })

  it("GET /dashboard/activity response matches DashboardActivitySchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/dashboard/activity?limit=5" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(DashboardActivitySchema, res.json(), "GET /dashboard/activity")
  })

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  it("GET /content response matches ContentListResponseSchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/content" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(ContentListResponseSchema, res.json(), "GET /content")
  })

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  it("GET /memory/search response matches MemorySearchResponseSchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({
      method: "GET",
      url: "/memory/search?agentId=agent-1&query=kubernetes",
    })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(MemorySearchResponseSchema, res.json(), "GET /memory/search")
  })

  it("POST /memory/sync response matches SyncMemoryResponseSchema", async () => {
    const mockSyncService = {
      sync: vi.fn().mockResolvedValue({ upserted: 3, deleted: 1, unchanged: 5 }),
    }
    const { app } = await buildTestAppWithSync(mockSyncService)
    const res = await app.inject({
      method: "POST",
      url: "/memory/sync",
      payload: { agentId: "agent-1" },
    })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(SyncMemoryResponseSchema, res.json(), "POST /memory/sync")
  })

  // -------------------------------------------------------------------------
  // Browser observation
  // -------------------------------------------------------------------------

  it("GET /agents/:agentId/browser response matches BrowserSessionSchema", async () => {
    const { app } = await buildTestApp()
    const res = await app.inject({ method: "GET", url: "/agents/agent-1/browser" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(BrowserSessionSchema, res.json(), "GET /agents/:agentId/browser")
  })

  it("GET /agents/:agentId/browser/screenshots response matches ScreenshotListResponseSchema", async () => {
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
    assertMatchesSchema(
      ScreenshotListResponseSchema,
      res.json(),
      "GET /agents/:agentId/browser/screenshots",
    )
  })

  it("GET /agents/:agentId/browser/events response matches BrowserEventListResponseSchema", async () => {
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
    assertMatchesSchema(
      BrowserEventListResponseSchema,
      res.json(),
      "GET /agents/:agentId/browser/events",
    )
  })

  // -------------------------------------------------------------------------
  // Pagination contract
  // -------------------------------------------------------------------------

  it("pagination objects from all list endpoints match PaginationSchema", async () => {
    const { app } = await buildTestApp()

    const jobsRes = await app.inject({ method: "GET", url: "/jobs?limit=10&offset=0" })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    assertMatchesSchema(PaginationSchema, jobsRes.json().pagination, "/jobs pagination")

    const contentRes = await app.inject({ method: "GET", url: "/content" })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    assertMatchesSchema(PaginationSchema, contentRes.json().pagination, "/content pagination")
  })
})

// ===========================================================================
// Contract Tests: Credential Routes ↔ Dashboard Schemas
// ===========================================================================

describe("cross-boundary contract: credential routes → dashboard schemas", () => {
  it("GET /credentials/providers response matches ProviderListResponseSchema", async () => {
    // Import credential routes and wire up with minimal deps
    const { credentialRoutes } = await import("../routes/credentials.js")

    const app = Fastify({ logger: false })

    await app.register(
      credentialRoutes({
        credentialService: {} as never,
        sessionService: {} as never,
        authConfig: {
          google: { clientId: "test", clientSecret: "test", callbackUrl: "http://localhost/cb" },
        } as never,
      }),
    )

    const res = await app.inject({ method: "GET", url: "/credentials/providers" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(ProviderListResponseSchema, res.json(), "GET /credentials/providers")
  })
})

// ===========================================================================
// Contract Tests: Model Routes ↔ Dashboard Schemas
// ===========================================================================

describe("cross-boundary contract: model routes → dashboard schemas", () => {
  it("GET /models response matches ModelListResponseSchema", async () => {
    const { modelRoutes } = await import("../routes/models.js")

    const app = Fastify({ logger: false })

    const mockDiscovery = {
      getAllCachedModels: vi.fn().mockReturnValue([
        { id: "claude-sonnet-4-6-20250514", label: "Claude Sonnet 4.6", providers: ["anthropic"] },
        { id: "gpt-4o", label: "GPT-4o", providers: ["openai"] },
      ]),
      getCachedModels: vi.fn().mockReturnValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
    }

    await app.register(modelRoutes({ discoveryService: mockDiscovery as never }))

    const res = await app.inject({ method: "GET", url: "/models" })
    expect(res.statusCode).toBe(200)
    assertMatchesSchema(ModelListResponseSchema, res.json(), "GET /models")
  })
})
