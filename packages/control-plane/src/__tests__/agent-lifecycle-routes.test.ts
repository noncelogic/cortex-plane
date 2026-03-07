/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import { AgentLifecycleManager, type LifecycleManagerDeps } from "../lifecycle/manager.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentLifecycleRoutes } from "../routes/agent-lifecycle.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

function makeMockDb(opts: { agentExists?: boolean; agentStatus?: string } = {}) {
  const { agentExists = true, agentStatus = "ACTIVE" } = opts

  const agentRow = agentExists ? { id: AGENT_ID, status: agentStatus } : null

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

async function buildTestApp(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    withManager?: boolean
    managerDb?: Kysely<Database>
  } = {},
) {
  const { agentExists = true, agentStatus = "ACTIVE", withManager = false } = opts

  const app = Fastify({ logger: false })
  const { db, updateExecute } = makeMockDb({ agentExists, agentStatus })

  const manager = withManager ? makeManager(opts.managerDb ?? db) : undefined

  await app.register(
    agentLifecycleRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
      lifecycleManager: manager,
    }),
  )

  return { app, db, updateExecute, manager }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/quarantine
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/quarantine", () => {
  it("quarantines an agent (DB-only, no lifecycle manager)", async () => {
    const { app, updateExecute } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "Manual quarantine for investigation" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.state).toBe("QUARANTINED")
    expect(body.reason).toBe("Manual quarantine for investigation")
    expect(body.quarantinedAt).toBeDefined()
    expect(updateExecute).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "test" },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("returns 409 when agent is already quarantined", async () => {
    const { app } = await buildTestApp({ agentStatus: "QUARANTINED" })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "test" },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
  })

  it("returns 400 when reason is missing", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("quarantines via lifecycle manager when agent is managed", async () => {
    const { db } = makeMockDb()
    configureDbForBoot(db)
    const manager = makeManager(db)

    // Boot and run the agent so it's in EXECUTING state
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")

    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/quarantine`,
      payload: { reason: "Circuit breaker tripped" },
    })

    expect(res.statusCode).toBe(200)
    expect(manager.getAgentState(AGENT_ID)).toBe("QUARANTINED")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/release
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/release", () => {
  it("releases a quarantined agent (DB-only, no lifecycle manager)", async () => {
    const { app, updateExecute } = await buildTestApp({ agentStatus: "QUARANTINED" })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/release`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.state).toBe("DRAINING")
    expect(body.releasedAt).toBeDefined()
    expect(updateExecute).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/release`,
      payload: {},
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("returns 409 when agent is not quarantined", async () => {
    const { app } = await buildTestApp({ agentStatus: "ACTIVE" })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/release`,
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
  })

  it("accepts resetCircuitBreaker flag", async () => {
    const { app } = await buildTestApp({ agentStatus: "QUARANTINED" })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/release`,
      payload: { resetCircuitBreaker: true },
    })

    expect(res.statusCode).toBe(200)
  })

  it("releases via lifecycle manager when agent is managed", async () => {
    const { db } = makeMockDb({ agentStatus: "QUARANTINED" })
    configureDbForBoot(db)
    const manager = makeManager(db)

    // Boot + run + quarantine to get to QUARANTINED state
    await manager.boot(AGENT_ID, "job-1")
    manager.run(AGENT_ID, "job-1")
    await manager.quarantine(AGENT_ID, "test")

    // After quarantine, DB should report QUARANTINED status for the route check
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const selectFrom = vi.mocked(db.selectFrom)
    selectFrom.mockImplementation((table: string) => {
      if (table === "agent") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue({ id: AGENT_ID, status: "QUARANTINED" }),
            }),
          }),
        }
      }
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    })

    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/release`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    expect(manager.getAgentState(AGENT_ID)).toBe("DRAINING")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/reset-health (#443)
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/reset-health", () => {
  it("resets health for an existing agent", async () => {
    const app = Fastify({ logger: false })

    const agentRow = {
      id: AGENT_ID,
      status: "ACTIVE",
      health_reset_at: new Date(),
    }

    const db = {
      selectFrom: vi.fn(),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(agentRow),
            }),
            execute: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Kysely<Database>

    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/reset-health`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.healthResetAt).toBeDefined()
  })

  it("returns 404 when agent does not exist", async () => {
    const app = Fastify({ logger: false })

    const db = {
      selectFrom: vi.fn(),
      updateTable: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(null),
            }),
            execute: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Kysely<Database>

    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/reset-health`,
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/boot?mode=safe
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/boot?mode=safe", () => {
  let manager: AgentLifecycleManager

  beforeEach(() => {
    const { db } = makeMockDb()
    manager = makeManager(db)
  })

  afterEach(() => {
    manager.shutdown()
  })

  it("boots agent in safe mode", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.state).toBe("SAFE_MODE")
    expect(body.restrictions).toEqual([
      "no_tools",
      "no_memory_context",
      "identity_only_system_prompt",
      "token_budget_10000",
      "single_turn_only",
    ])
  })

  it("boots agent in safe mode with custom jobId", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: { jobId: "debug-job-123" },
    })

    expect(res.statusCode).toBe(200)
    const ctx = manager.getAgentContext(AGENT_ID)
    expect(ctx?.jobId).toBe("debug-job-123")
  })

  it("returns 400 when mode is not safe", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe("bad_request")
  })

  it("returns 404 when agent does not exist", async () => {
    const { db } = makeMockDb({ agentExists: false })
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 409 when agent is already booted", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    // Boot once
    manager.bootSafeMode(AGENT_ID)

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
  })

  it("returns 503 when lifecycle manager is not available", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        // No lifecycleManager
      }),
    )

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    expect(res.statusCode).toBe(503)
  })

  it("safe-mode agent can transition to READY", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    const ctx = manager.getAgentContext(AGENT_ID)
    expect(ctx).toBeDefined()
    expect(ctx!.stateMachine.state).toBe("SAFE_MODE")

    // SAFE_MODE → READY should be valid
    ctx!.stateMachine.transition("READY", "Debug session complete")
    expect(ctx!.stateMachine.state).toBe("READY")
  })

  it("safe-mode boot skips hydration (no memory context)", async () => {
    const { db } = makeMockDb()
    const app = Fastify({ logger: false })
    await app.register(
      agentLifecycleRoutes({
        db,
        authConfig: DEV_AUTH_CONFIG,
        lifecycleManager: manager,
      }),
    )

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/boot?mode=safe`,
      payload: {},
    })

    const ctx = manager.getAgentContext(AGENT_ID)
    expect(ctx?.hydration).toBeNull()
  })
})
