/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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

/** CRC32 of deterministic JSON for `{ "hello": "world" }` */
const SAMPLE_STATE = { hello: "world" }
// Pre-computed via computeCheckpointCrc({ hello: "world" })
const SAMPLE_STATE_CRC = 3624485329

function makeCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECKPOINT_ID,
    agent_id: AGENT_ID,
    job_id: JOB_ID,
    label: "v1",
    state: SAMPLE_STATE,
    state_crc: SAMPLE_STATE_CRC,
    context_snapshot: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "dev-user",
    ...overrides,
  }
}

/**
 * Build a mock Kysely database that supports the query patterns used by
 * agentCheckpointRoutes.
 */
function mockDb(
  opts: {
    agentExists?: boolean
    checkpoints?: Record<string, unknown>[]
    totalCount?: number
    checkpoint?: Record<string, unknown> | null
    insertedCheckpoint?: Record<string, unknown>
    latestJob?: Record<string, unknown> | null
    crcValid?: boolean
  } = {},
) {
  const {
    agentExists = true,
    checkpoints = [makeCheckpoint()],
    totalCount = 1,
    checkpoint = makeCheckpoint(),
    insertedCheckpoint = makeCheckpoint(),
    latestJob = {
      id: JOB_ID,
      checkpoint: SAMPLE_STATE,
      checkpoint_crc: SAMPLE_STATE_CRC,
    } as Record<string, unknown> | null,
    crcValid = true,
  } = opts

  // If crcValid is false, corrupt the state_crc in the checkpoint
  const resolvedCheckpoint = checkpoint
    ? {
        ...checkpoint,
        state_crc: crcValid ? (checkpoint as Record<string, unknown>).state_crc : 99999,
      }
    : null

  const updateExecute = vi.fn().mockResolvedValue([])
  const eventInsertValues = vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue([]),
  })

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") {
        const row = agentExists ? { id: AGENT_ID } : null
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(row),
            }),
          }),
        }
      }

      if (table === "agent_checkpoint") {
        // Universal chainable node for both list + single lookups
        const chain: Record<string, ReturnType<typeof vi.fn>> = {}
        const self = () => chain
        chain.where = vi.fn().mockImplementation(self)
        chain.orderBy = vi.fn().mockImplementation(self)
        chain.limit = vi.fn().mockImplementation(self)
        chain.offset = vi.fn().mockImplementation(self)
        chain.execute = vi.fn().mockResolvedValue(checkpoints)
        chain.executeTakeFirst = vi.fn().mockResolvedValue(resolvedCheckpoint)
        chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue({ total: totalCount })

        return {
          select: vi.fn().mockReturnValue(chain),
          selectAll: vi.fn().mockReturnValue(chain),
        }
      }

      if (table === "job") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  executeTakeFirst: vi.fn().mockResolvedValue(latestJob),
                }),
              }),
              orderBy: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(latestJob),
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

      if (table === "agent_event") {
        return { values: eventInsertValues }
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
          where: vi.fn().mockReturnValue({
            execute: updateExecute,
          }),
          execute: updateExecute,
        }),
      }),
    }),

    fn: {
      countAll: vi.fn().mockReturnValue({
        as: vi.fn().mockReturnValue("count_expr"),
      }),
    },
  } as unknown as Kysely<Database>

  return { db, updateExecute, eventInsertValues }
}

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const { db, updateExecute, eventInsertValues } = mockDb(dbOpts)

  await app.register(agentCheckpointRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

  return { app, db, updateExecute, eventInsertValues }
}

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/checkpoints
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/checkpoints", () => {
  it("returns paginated checkpoints sorted by created_at DESC", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/checkpoints`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.checkpoints).toBeDefined()
    expect(Array.isArray(body.checkpoints)).toBe(true)
    expect(typeof body.total).toBe("number")
    expect(body.checkpoints[0].id).toBe(CHECKPOINT_ID)
    expect(body.checkpoints[0].agentId).toBe(AGENT_ID)
    expect(body.checkpoints[0].stateCrc).toBe(SAMPLE_STATE_CRC)
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/checkpoints`,
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Agent")
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
      payload: { label: "v1" },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBe(CHECKPOINT_ID)
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.label).toBe("v1")
    expect(typeof body.stateCrc).toBe("number")
    expect(body.createdBy).toBe("dev-user")
  })

  it("creates a checkpoint without label", async () => {
    const cp = makeCheckpoint({ label: null })
    const { app } = await buildTestApp({ insertedCheckpoint: cp })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/checkpoints`,
      payload: {},
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.label).toBeNull()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/checkpoints`,
      payload: { label: "test" },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Agent")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/rollback
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/rollback", () => {
  it("quarantines agent, restores checkpoint, logs event", async () => {
    const { app, updateExecute, eventInsertValues } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe("QUARANTINED")
    expect(body.restoredFrom).toBe(CHECKPOINT_ID)

    // Agent status update + job checkpoint write
    expect(updateExecute).toHaveBeenCalled()
    // Event log
    expect(eventInsertValues).toHaveBeenCalled()
  })

  it("returns 404 with invalid checkpoint ID", async () => {
    const { app } = await buildTestApp({ checkpoint: null })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: "nonexistent-id" },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Checkpoint")
  })

  it("returns 409 with CRC mismatch", async () => {
    const { app } = await buildTestApp({ crcValid: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.message).toContain("CRC")
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("Agent")
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

  it("accepts restoreContext flag", async () => {
    const cp = makeCheckpoint({
      context_snapshot: { context_window: [{ role: "user", content: "hi" }] },
    })
    const { app } = await buildTestApp({ checkpoint: cp })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/rollback`,
      payload: { checkpointId: CHECKPOINT_ID, restoreContext: true },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe("QUARANTINED")
  })
})
