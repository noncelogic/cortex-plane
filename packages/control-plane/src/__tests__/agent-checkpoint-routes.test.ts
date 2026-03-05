import { crc32 } from "node:zlib"

import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentCheckpointRoutes } from "../routes/agent-checkpoints.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const CHECKPOINT_ID = "cccccccc-1111-2222-3333-444444444444"
const JOB_ID = "jjjjjjjj-1111-2222-3333-444444444444"

function computeStateCrc(state: Record<string, unknown>): number {
  return crc32(Buffer.from(JSON.stringify(state), "utf-8"))
}

const CHECKPOINT_STATE = { step: 3, context: "test" }
const CHECKPOINT_CRC = computeStateCrc(CHECKPOINT_STATE)

function makeCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECKPOINT_ID,
    agent_id: AGENT_ID,
    label: "before-deploy",
    state: CHECKPOINT_STATE,
    context_snapshot: { memory: "snapshot" },
    state_crc: CHECKPOINT_CRC,
    created_by: "dev-user",
    created_at: new Date(),
    ...overrides,
  }
}

/**
 * Build a mock Kysely database supporting agent-checkpoint route queries.
 */
function mockDb(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    checkpoints?: Record<string, unknown>[]
    checkpointCount?: number
    checkpoint?: Record<string, unknown> | null
    latestJob?: Record<string, unknown> | null
    insertedCheckpoint?: Record<string, unknown>
  } = {},
) {
  const {
    agentExists = true,
    agentStatus = "ACTIVE",
    checkpoints = [makeCheckpoint()],
    checkpointCount = checkpoints.length,
    checkpoint = makeCheckpoint(),
    latestJob = { id: JOB_ID, checkpoint: CHECKPOINT_STATE, checkpoint_crc: CHECKPOINT_CRC },
    insertedCheckpoint = makeCheckpoint(),
  } = opts

  const updateExecute = vi.fn().mockResolvedValue([])
  const auditInsertExecute = vi.fn().mockResolvedValue([])

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        const row = agentExists ? { id: AGENT_ID, status: agentStatus } : null
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(row),
            }),
          }),
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(
                agentExists
                  ? {
                      id: AGENT_ID,
                      status: agentStatus,
                      config: {},
                    }
                  : null,
              ),
            }),
          }),
        }
      }

      if (table === "agent_checkpoint") {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              const chain = {
                where: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(checkpoint),
                }),
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue({
                      execute: vi.fn().mockResolvedValue(checkpoints),
                    }),
                  }),
                }),
                executeTakeFirst: vi.fn().mockResolvedValue(checkpoint),
              }
              return chain
            }),
          }),
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ total: checkpointCount }),
            }),
          }),
        }
      }

      if (table === "job") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(latestJob),
                }),
              }),
            }),
          }),
        }
      }

      // Fallback
      return {
        select: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_checkpoint") {
        return {
          values: vi.fn().mockReturnValue({
            returningAll: vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue(insertedCheckpoint),
            }),
          }),
        }
      }

      if (table === "approval_audit_log") {
        return {
          values: vi.fn().mockReturnValue({
            execute: auditInsertExecute,
          }),
        }
      }

      return {
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue([]),
        }),
      }
    }),

    updateTable: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          execute: updateExecute,
        }),
      }),
    }),

    fn: {
      countAll: () => ({ as: () => "count(*) as total" }),
    },
  } as unknown as Kysely<Database>

  return { db, updateExecute, auditInsertExecute }
}

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const { db, updateExecute, auditInsertExecute } = mockDb(dbOpts)

  await app.register(agentCheckpointRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

  return { app, db, updateExecute, auditInsertExecute }
}

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/checkpoints
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/checkpoints", () => {
  it("returns paginated checkpoints sorted by created_at DESC", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/checkpoints?limit=10&offset=0`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.checkpoints).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(Array.isArray(body.checkpoints)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.total).toBe(1)
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/checkpoints`,
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/checkpoints
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/checkpoints", () => {
  it("creates a checkpoint with CRC32 integrity", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/checkpoints`,
      payload: { label: "before-deploy" },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.id).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.agentId).toBe(AGENT_ID)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.stateCrc).toBe(CHECKPOINT_CRC)
  })

  it("creates a checkpoint without label", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/checkpoints`,
      payload: {},
    })

    expect(res.statusCode).toBe(201)
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/checkpoints`,
      payload: { label: "test" },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/rollback
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/rollback", () => {
  it("quarantines agent and restores checkpoint", async () => {
    const { app, updateExecute, auditInsertExecute } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.state).toBe("QUARANTINED")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.restoredFrom).toBe(CHECKPOINT_ID)

    // Verify agent was quarantined and audit log was written
    expect(updateExecute).toHaveBeenCalled()
    expect(auditInsertExecute).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })

  it("returns 404 with invalid checkpoint ID", async () => {
    const { app } = await buildTestApp({ checkpoint: null })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: "nonexistent-id" },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Checkpoint")
  })

  it("returns 409 on CRC mismatch", async () => {
    const { app } = await buildTestApp({
      checkpoint: makeCheckpoint({ state_crc: 99999 }),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("CRC32")
  })

  it("validates required checkpointId field", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})
