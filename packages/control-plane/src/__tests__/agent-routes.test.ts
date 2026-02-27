import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentRoutes } from "../routes/agents.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "Test Agent",
    slug: "test-agent",
    role: "assistant",
    description: "A test agent",
    model_config: {},
    skill_config: {},
    resource_limits: {},
    channel_permissions: {},
    status: "ACTIVE",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    session_id: null,
    status: "PENDING",
    priority: 0,
    payload: { prompt: "Hello" },
    result: null,
    checkpoint: null,
    checkpoint_crc: null,
    error: null,
    attempt: 1,
    max_attempts: 3,
    timeout_seconds: 300,
    created_at: new Date(),
    updated_at: new Date(),
    started_at: null,
    completed_at: null,
    heartbeat_at: null,
    approval_expires_at: null,
    ...overrides,
  }
}

/** Build a chainable mock that simulates Kysely's fluent query API. */
function mockDb(
  opts: {
    agents?: Record<string, unknown>[]
    jobs?: Record<string, unknown>[]
    insertedAgent?: Record<string, unknown>
    updatedAgent?: Record<string, unknown> | null
    insertedJob?: Record<string, unknown>
  } = {},
) {
  const {
    agents = [makeAgent()],
    jobs = [],
    insertedAgent = makeAgent(),
    updatedAgent = makeAgent(),
    insertedJob = makeJob(),
  } = opts

  // Chain builder for selectFrom — every node returns all possible continuations
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

  // Chain builder for insertInto
  function insertChain(row: Record<string, unknown>) {
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(row)
    const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
    const values = vi.fn().mockReturnValue({ returningAll })
    return { values }
  }

  // Chain builder for updateTable
  function updateChain(row: Record<string, unknown> | null) {
    const executeTakeFirst = vi.fn().mockResolvedValue(row)
    const execute = vi.fn().mockResolvedValue(row ? [row] : [])
    const returningAll = vi.fn().mockReturnValue({ executeTakeFirst })
    const where = vi
      .fn()
      .mockReturnValue({
        returningAll,
        execute,
        where: vi.fn().mockReturnValue({ returningAll, execute }),
      })
    const set = vi.fn().mockReturnValue({ where })
    return { set }
  }

  return {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") return selectChain(agents)
      if (table === "job") return selectChain(jobs)
      return selectChain([])
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") return insertChain(insertedAgent)
      if (table === "job") return insertChain(insertedJob)
      return insertChain({})
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") return updateChain(updatedAgent)
      if (table === "job") return updateChain(insertedJob)
      return updateChain(null)
    }),
  } as unknown as Kysely<Database>
}

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const db = mockDb(dbOpts)
  const enqueueJob = vi.fn().mockResolvedValue(undefined)

  await app.register(agentRoutes({ db, authConfig: DEV_AUTH_CONFIG, enqueueJob }))

  return { app, db, enqueueJob }
}

// ---------------------------------------------------------------------------
// Tests: GET /agents
// ---------------------------------------------------------------------------

describe("GET /agents", () => {
  it("returns list of agents", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent(), makeAgent({ id: "other-id", name: "Other" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agents).toBeDefined()
    expect(body.count).toBeGreaterThanOrEqual(1)
  })

  it("accepts status filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/agents?status=ACTIVE" })

    expect(res.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:id
// ---------------------------------------------------------------------------

describe("GET /agents/:id", () => {
  it("returns agent with latest job", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe("Test Agent")
    expect("latest_job" in body).toBe(true)
  })

  it("returns 404 for nonexistent agent", async () => {
    const { app } = await buildTestApp({ agents: [] })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents
// ---------------------------------------------------------------------------

describe("POST /agents", () => {
  it("creates an agent", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "New Agent",
        role: "assistant",
        description: "A new agent",
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe("Test Agent") // Returns mock data
  })

  it("validates required fields", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { description: "Missing name and role" },
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/pause + /resume
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/pause", () => {
  it("returns pausing status", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/pause",
      payload: { reason: "manual", timeoutSeconds: 30 },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      status: "pausing",
    })
  })
})

describe("POST /agents/:agentId/resume", () => {
  it("returns resuming status", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resume",
      payload: { checkpointId: "chk-1" },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      status: "resuming",
      fromCheckpoint: "chk-1",
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /agents/:id
// ---------------------------------------------------------------------------

describe("PUT /agents/:id", () => {
  it("updates an agent", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      payload: { name: "Updated Agent" },
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 400 with empty body", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 404 for nonexistent agent", async () => {
    const { app } = await buildTestApp({ updatedAgent: null })

    const res = await app.inject({
      method: "PUT",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      payload: { name: "Updated" },
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:id
// ---------------------------------------------------------------------------

describe("DELETE /agents/:id", () => {
  it("soft deletes an agent", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 404 for nonexistent agent", async () => {
    const { app } = await buildTestApp({ updatedAgent: null })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:id/jobs
// ---------------------------------------------------------------------------

describe("GET /agents/:id/jobs", () => {
  it("returns jobs for an agent", async () => {
    const { app } = await buildTestApp({ jobs: [makeJob()] })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.jobs).toBeDefined()
  })

  it("returns 404 for nonexistent agent", async () => {
    const { app } = await buildTestApp({ agents: [] })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:id/jobs
// ---------------------------------------------------------------------------

describe("POST /agents/:id/jobs", () => {
  it("creates and enqueues a job", async () => {
    const { app, enqueueJob } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
      payload: {
        prompt: "Write a hello world function",
        goal_type: "code_generate",
      },
    })

    expect(res.statusCode).toBe(201)
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const body = res.json()
    expect(body.status).toBe("SCHEDULED")
  })

  it("validates prompt is required", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("returns 404 for nonexistent agent", async () => {
    const { app } = await buildTestApp({ agents: [] })

    const res = await app.inject({
      method: "POST",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
      payload: { prompt: "test" },
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 409 for non-ACTIVE agent", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ status: "DISABLED" })],
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
      payload: { prompt: "test" },
    })

    expect(res.statusCode).toBe(409)
  })

  it("still creates job even if enqueue fails", async () => {
    const { app } = await buildTestApp()
    // Override enqueueJob to fail — the route handles this gracefully
    const failApp = Fastify({ logger: false })
    const failEnqueue = vi.fn().mockRejectedValue(new Error("Queue down"))
    await failApp.register(
      agentRoutes({ db: mockDb(), authConfig: DEV_AUTH_CONFIG, enqueueJob: failEnqueue }),
    )

    const res = await failApp.inject({
      method: "POST",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/jobs`,
      payload: { prompt: "test" },
    })

    // Job is still created and returned with SCHEDULED status
    expect(res.statusCode).toBe(201)
  })
})
