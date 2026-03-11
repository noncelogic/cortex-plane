/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import { AgentLifecycleManager, type LifecycleManagerDeps } from "../lifecycle/manager.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentRoutes } from "../routes/agents.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

function makeMockDb(opts: { agentExists?: boolean } = {}) {
  const { agentExists = true } = opts

  const agentRow = agentExists ? { id: AGENT_ID, status: "ACTIVE" } : null

  const updateExecute = vi.fn().mockResolvedValue([])

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(agentRow),
            }),
          }),
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(agentRow),
            }),
          }),
        }
      }
      // fallback for hydration queries (job + agent identity)
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    }),

    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            execute: updateExecute,
          }),
          execute: updateExecute,
        }),
      }),
    }),
  } as unknown as Kysely<Database>

  return { db, updateExecute }
}

function makeMockDeployer() {
  return {
    deployAgent: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    getAgentStatus: vi.fn().mockResolvedValue(null),
    listAgents: vi.fn().mockResolvedValue([]),
  } as unknown as AgentDeployer
}

function makeManager(db: Kysely<Database>) {
  return new AgentLifecycleManager({
    db,
    deployer: makeMockDeployer(),
  } satisfies LifecycleManagerDeps)
}

/**
 * Configure the mock DB so that boot() succeeds (hydration returns valid data).
 */
function configureDbForBoot(db: Kysely<Database>) {
  let callCount = 0
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const selectFrom = vi.mocked(db.selectFrom)
  selectFrom.mockImplementation((table: string) => {
    if (table === "agent") {
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({ id: AGENT_ID, status: "ACTIVE" }),
          }),
        }),
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue({
              id: AGENT_ID,
              name: "Test Agent",
              slug: "test-agent",
              role: "devops",
              description: null,
              model_config: {},
              skill_config: {},
              resource_limits: {},
            }),
          }),
        }),
      }
    }
    // job table (hydration checkpoint lookup)
    callCount++
    return {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(
            callCount === 1
              ? {
                  checkpoint: { step: 0 },
                  checkpoint_crc: 123,
                  status: "RUNNING",
                  attempt: 1,
                  payload: { task: "test" },
                }
              : null,
          ),
        }),
      }),
      selectAll: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          executeTakeFirst: vi.fn().mockResolvedValue(null),
        }),
      }),
    }
  })
}

const enqueueJob = vi.fn().mockResolvedValue(undefined)

async function buildTestApp(opts: {
  agentExists?: boolean
  lifecycleManager?: AgentLifecycleManager
  managerDb?: Kysely<Database>
}) {
  const { agentExists = true, lifecycleManager } = opts
  const { db } = makeMockDb({ agentExists })

  const app = Fastify({ logger: false })
  await app.register(
    agentRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
      enqueueJob,
      lifecycleManager,
    }),
  )

  return { app, db }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/pause
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/pause", () => {
  let manager: AgentLifecycleManager

  afterEach(() => {
    manager?.shutdown()
  })

  it("pauses an executing agent via lifecycle manager", async () => {
    const { db } = makeMockDb()
    configureDbForBoot(db)
    manager = makeManager(db)

    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    const { app } = await buildTestApp({ lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pause`,
      payload: { reason: "Manual investigation" },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.status).toBe("pausing")
  })

  it("returns 404 when agent does not exist", async () => {
    const { db } = makeMockDb()
    manager = makeManager(db)
    const { app } = await buildTestApp({ agentExists: false, lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pause`,
      payload: {},
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("returns 503 when lifecycle manager is not available", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pause`,
      payload: {},
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe("service_unavailable")
  })

  it("returns 409 when agent is not managed (not executing)", async () => {
    const { db } = makeMockDb()
    manager = makeManager(db)
    const { app } = await buildTestApp({ lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pause`,
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
    expect(res.json().message).toContain("not currently managed")
  })

  it("returns 409 when agent is not in EXECUTING state", async () => {
    const { db } = makeMockDb()
    manager = makeManager(db)
    // Boot into SAFE_MODE (not EXECUTING)
    manager.bootSafeMode(AGENT_ID)

    const { app } = await buildTestApp({ lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pause`,
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
    expect(res.json().message).toContain("not in EXECUTING state")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/resume
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/resume", () => {
  let manager: AgentLifecycleManager

  afterEach(() => {
    manager?.shutdown()
  })

  it("resumes a paused agent via lifecycle manager", async () => {
    const { db } = makeMockDb()
    configureDbForBoot(db)
    manager = makeManager(db)

    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")
    await manager.pause(AGENT_ID)

    const { app } = await buildTestApp({ lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/resume`,
      payload: { checkpointId: "cp-123" },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.status).toBe("resuming")
    expect(body.fromCheckpoint).toBe("cp-123")
  })

  it("returns 404 when agent does not exist", async () => {
    const { db } = makeMockDb()
    manager = makeManager(db)
    const { app } = await buildTestApp({ agentExists: false, lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/resume`,
      payload: {},
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("returns 503 when lifecycle manager is not available", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/resume`,
      payload: {},
    })

    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe("service_unavailable")
  })

  it("returns 409 when agent is not managed", async () => {
    const { db } = makeMockDb()
    manager = makeManager(db)
    const { app } = await buildTestApp({ lifecycleManager: manager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/resume`,
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
    expect(res.json().message).toContain("not currently managed")
  })
})
