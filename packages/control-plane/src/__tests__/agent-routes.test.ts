import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentRoutes, deriveLifecycleState } from "../routes/agents.js"

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
    config: {},
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

function makeAgentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "eeeeeeee-1111-2222-3333-444444444444",
    agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    job_id: null,
    event_type: "llm_call",
    cost_usd: "0.005000",
    payload: { model: "claude-3-sonnet" },
    created_at: new Date(),
    ...overrides,
  }
}

/** Build a chainable mock that simulates Kysely's fluent query API. */
function mockDb(
  opts: {
    agents?: Record<string, unknown>[]
    jobs?: Record<string, unknown>[]
    agentEvents?: Record<string, unknown>[]
    grantRows?: Record<string, unknown>[]
    sessions?: Record<string, unknown>[]
    insertedAgent?: Record<string, unknown>
    updatedAgent?: Record<string, unknown> | null
    insertedJob?: Record<string, unknown>
  } = {},
) {
  const {
    agents = [makeAgent()],
    jobs = [],
    agentEvents = [],
    grantRows = [],
    sessions = [],
    insertedAgent = makeAgent(),
    updatedAgent = makeAgent(),
    insertedJob = makeJob(),
  } = opts

  // Chain builder for selectFrom — every node returns all possible continuations
  function selectChain(rows: Record<string, unknown>[]) {
    const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(rows[0] ?? {})
    const execute = vi.fn().mockResolvedValue(rows)
    const terminal = { execute, executeTakeFirst, executeTakeFirstOrThrow }
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
    // Count queries use select(fn.countAll().as("total"|"cnt")) — return { total, cnt }
    // Regular selects (e.g. select("id")) still need where/executeTakeFirst
    const countResult = { total: rows.length, cnt: rows.length }
    const selectTerminal = {
      executeTakeFirst,
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue(countResult),
      execute,
    }
    const groupBy = vi.fn().mockReturnValue(selectTerminal)
    const selectWhereFn: ReturnType<typeof vi.fn> = vi.fn()
    selectWhereFn.mockReturnValue({
      where: selectWhereFn,
      groupBy,
      ...selectTerminal,
    })
    const select = vi.fn().mockReturnValue({ where: selectWhereFn, groupBy, ...selectTerminal })
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
    const where = vi.fn().mockReturnValue({
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
      if (table === "agent_event") return selectChain(agentEvents)
      if (table === "agent_user_grant") return selectChain(grantRows)
      if (table === "session") return selectChain(sessions)
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
    fn: {
      countAll: () => ({
        as: () => "count(*) as total",
      }),
    },
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.agents).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.count).toBeGreaterThanOrEqual(1)
  })

  it("accepts status filter", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({ method: "GET", url: "/agents?status=ACTIVE" })

    expect(res.statusCode).toBe(200)
  })

  it("includes costToday, healthStatus, and runningJobId", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      agentEvents: [
        makeAgentEvent({ cost_usd: "0.005000" }),
        makeAgentEvent({ id: "event-2", cost_usd: "0.003000" }),
      ],
      jobs: [makeJob({ status: "RUNNING" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.costToday).toBe(0.008)
    expect(agent.healthStatus).toBe("healthy")
    expect(agent.runningJobId).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("returns zero costToday and null runningJobId when no events or running jobs", async () => {
    const { app } = await buildTestApp({ agents: [makeAgent()] })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.costToday).toBe(0)
    expect(agent.runningJobId).toBeNull()
  })

  it("maps DISABLED status to degraded healthStatus", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ status: "DISABLED" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.healthStatus).toBe("degraded")
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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

  it("includes costSummary, healthStatus, runningJobId, and circuitBreakerState", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      agentEvents: [
        makeAgentEvent({ cost_usd: "0.010000", payload: { model: "claude-3-opus" } }),
        makeAgentEvent({
          id: "event-2",
          cost_usd: "0.005000",
          payload: { model: "claude-3-sonnet" },
        }),
      ],
      jobs: [makeJob({ status: "RUNNING" })],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    expect(body).toHaveProperty("costSummary")
    expect(body).toHaveProperty("healthStatus", "healthy")
    expect(body).toHaveProperty("runningJobId", "11111111-2222-3333-4444-555555555555")
    expect(body).toHaveProperty("circuitBreakerState")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const cs = body.costSummary as Record<string, unknown>
    expect(cs.totalAllTime).toBe(0.015)
    expect(cs.totalToday).toBe(0.015)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const cb = body.circuitBreakerState as Record<string, unknown>
    expect(cb.tripped).toBe(false)
    expect(cb.consecutiveFailures).toBe(0)
  })

  it("reports tripped circuit breaker on consecutive failures", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      agentEvents: [
        makeAgentEvent({
          id: "e1",
          event_type: "error",
          cost_usd: "0",
          payload: { reason: "timeout" },
        }),
        makeAgentEvent({ id: "e2", event_type: "tool_error", cost_usd: "0", payload: {} }),
        makeAgentEvent({ id: "e3", event_type: "error", cost_usd: "0", payload: {} }),
      ],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const cb = body.circuitBreakerState as Record<string, unknown>
    expect(cb.tripped).toBe(true)
    expect(cb.consecutiveFailures).toBe(3)
    expect(cb.tripReason).toBe("timeout")
  })

  it("includes costSummary model breakdown", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      agentEvents: [
        makeAgentEvent({ id: "e1", cost_usd: "0.010000", payload: { model: "claude-3-opus" } }),
        makeAgentEvent({ id: "e2", cost_usd: "0.002000", payload: { model: "claude-3-opus" } }),
        makeAgentEvent({ id: "e3", cost_usd: "0.005000", payload: { model: "claude-3-sonnet" } }),
      ],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const cs = body.costSummary as { byModel: Record<string, number> }
    expect(cs.byModel["claude-3-opus"]).toBeCloseTo(0.012)
    expect(cs.byModel["claude-3-sonnet"]).toBeCloseTo(0.005)
  })
})

// ---------------------------------------------------------------------------
// Tests: authWarnings + grantCount (#448)
// ---------------------------------------------------------------------------

describe("authWarnings and grantCount (#448)", () => {
  it("GET /agents includes authWarnings for allowlist agent with zero grants", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ auth_model: "allowlist" })],
      grantRows: [],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.grantCount).toBe(0)
    expect(agent.authWarnings).toEqual([
      "Allowlist agent has zero grants — all messages will be denied.",
    ])
  })

  it("GET /agents returns empty authWarnings for open agent", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ auth_model: "open" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.authWarnings).toEqual([])
  })

  it("GET /agents/:id includes authWarnings for allowlist agent with zero grants", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ auth_model: "allowlist" })],
      grantRows: [],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.grantCount).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.authWarnings).toEqual([
      "Allowlist agent has zero grants — all messages will be denied.",
    ])
  })

  it("GET /agents/:id returns empty authWarnings when allowlist agent has grants", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ auth_model: "allowlist" })],
      grantRows: [{ agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cnt: 2 }],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.authWarnings).toEqual([])
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.name).toBe("Test Agent") // Returns mock data
  })

  it("accepts model_config with model selection", async () => {
    const created = makeAgent({ model_config: { provider: "openai", model: "gpt-4o" } })
    const { app, db } = await buildTestApp({ insertedAgent: created })

    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "Agent With Model",
        role: "assistant",
        model_config: { provider: "openai", model: "gpt-4o" },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.model_config).toEqual({ provider: "openai", model: "gpt-4o" })

    // Verify db.insertInto was called with model_config
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("agent")
  })

  it("accepts model_config with model and systemPrompt", async () => {
    const created = makeAgent({
      model_config: { provider: "openai", model: "gpt-4o", systemPrompt: "Be helpful" },
    })
    const { app } = await buildTestApp({ insertedAgent: created })

    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "GPT Agent",
        role: "analyst",
        model_config: { provider: "openai", model: "gpt-4o", systemPrompt: "Be helpful" },
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.model_config).toEqual({
      provider: "openai",
      model: "gpt-4o",
      systemPrompt: "Be helpful",
    })
  })

  it("rejects invalid provider/model combinations", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "Bad Agent",
        role: "assistant",
        model_config: { provider: "anthropic", model: "gpt-4o" },
      },
    })

    expect(res.statusCode).toBe(400)
    const body: { code: string } = res.json()
    expect(body.code).toBe("provider_model_invalid")
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
  it("returns 503 when lifecycle manager is not available", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/pause",
      payload: { reason: "manual", timeoutSeconds: 30 },
    })

    expect(res.statusCode).toBe(503)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().error).toBe("service_unavailable")
  })
})

describe("POST /agents/:agentId/resume", () => {
  it("returns 503 when lifecycle manager is not available", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resume",
      payload: { checkpointId: "chk-1" },
    })

    expect(res.statusCode).toBe(503)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().error).toBe("service_unavailable")
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

  it("rejects ambiguous model-only updates", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      payload: { model_config: { model: "gpt-4o" } },
    })

    expect(res.statusCode).toBe(400)
    const body: { code: string } = res.json()
    expect(body.code).toBe("model_provider_ambiguous")
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:id
// ---------------------------------------------------------------------------

describe("DELETE /agents/:id", () => {
  it("soft deletes an agent with no active sessions", async () => {
    const { app } = await buildTestApp({ sessions: [] })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 409 when agent has active sessions", async () => {
    const { app } = await buildTestApp({
      sessions: [
        { id: "s1", agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "active" },
        { id: "s2", agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "active" },
        { id: "s3", agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", status: "active" },
      ],
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("active_sessions")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.sessionCount).toBe(3)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.message).toContain("3 active sessions")
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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
    const { app: _app } = await buildTestApp()
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

// ---------------------------------------------------------------------------
// Tests: deriveLifecycleState (#426)
// ---------------------------------------------------------------------------

describe("deriveLifecycleState", () => {
  it("returns READY for ACTIVE agent with no running job", () => {
    expect(deriveLifecycleState("ACTIVE", false)).toBe("READY")
  })

  it("returns EXECUTING for ACTIVE agent with a running job", () => {
    expect(deriveLifecycleState("ACTIVE", true)).toBe("EXECUTING")
  })

  it("returns DRAINING for DISABLED agent", () => {
    expect(deriveLifecycleState("DISABLED", false)).toBe("DRAINING")
  })

  it("returns TERMINATED for ARCHIVED agent", () => {
    expect(deriveLifecycleState("ARCHIVED", false)).toBe("TERMINATED")
  })

  it("returns READY for unknown status", () => {
    expect(deriveLifecycleState("QUARANTINED" as never, false)).toBe("READY")
  })
})

// ---------------------------------------------------------------------------
// Tests: lifecycle_state in API responses (#426)
// ---------------------------------------------------------------------------

describe("lifecycle_state in responses (#426)", () => {
  it("GET /agents includes lifecycle_state READY for ACTIVE agent without running job", async () => {
    const { app } = await buildTestApp({ agents: [makeAgent()] })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.lifecycle_state).toBe("READY")
  })

  it("GET /agents includes lifecycle_state EXECUTING when agent has running job", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      jobs: [makeJob({ status: "RUNNING" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.lifecycle_state).toBe("EXECUTING")
  })

  it("GET /agents includes lifecycle_state DRAINING for DISABLED agent", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent({ status: "DISABLED" })],
    })

    const res = await app.inject({ method: "GET", url: "/agents" })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const agent = body.agents[0] as Record<string, unknown>
    expect(agent.lifecycle_state).toBe("DRAINING")
  })

  it("GET /agents/:id includes lifecycle_state READY for ACTIVE agent", async () => {
    const { app } = await buildTestApp({ agents: [makeAgent()] })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.lifecycle_state).toBe("READY")
  })

  it("GET /agents/:id includes lifecycle_state EXECUTING when running job exists", async () => {
    const { app } = await buildTestApp({
      agents: [makeAgent()],
      jobs: [makeJob({ status: "RUNNING" })],
    })

    const res = await app.inject({
      method: "GET",
      url: `/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.lifecycle_state).toBe("EXECUTING")
  })
})
