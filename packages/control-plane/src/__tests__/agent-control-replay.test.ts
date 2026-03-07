/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import type { AgentEventEmitter } from "../observability/event-emitter.js"
import { agentControlRoutes } from "../routes/agent-control.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const CHECKPOINT_ID = "cccccccc-1111-2222-3333-444444444444"
const VALID_STATE = { hello: "world" }
const VALID_CRC = 3624485329

function makeMockDb(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    checkpointExists?: boolean
    checkpointCrc?: number
    checkpointState?: Record<string, unknown>
  } = {},
) {
  const {
    agentExists = true,
    agentStatus = "ACTIVE",
    checkpointExists = true,
    checkpointCrc = VALID_CRC,
    checkpointState = VALID_STATE,
  } = opts

  const agentRow = agentExists ? { id: AGENT_ID, status: agentStatus } : null
  const checkpointRow = checkpointExists
    ? {
        id: CHECKPOINT_ID,
        agent_id: AGENT_ID,
        job_id: "job-old",
        label: "v1",
        state: checkpointState,
        state_crc: checkpointCrc,
        context_snapshot: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        created_by: "dev-user",
      }
    : null

  const insertedJob = {
    id: "job-replay-1",
    agent_id: AGENT_ID,
    session_id: null,
    status: "CREATED",
    payload: {},
    priority: 0,
    timeout_seconds: 300,
    max_attempts: 1,
    attempt: 0,
    created_at: new Date(),
    updated_at: new Date(),
  }

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
      if (table === "agent_checkpoint") {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(checkpointRow),
              }),
            }),
          }),
        }
      }
      if (table === "job") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(null),
              }),
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
    }),

    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returningAll: vi.fn().mockReturnValue({
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue(insertedJob),
        }),
      }),
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

  return { db, updateExecute, insertedJob }
}

function makeMockEventEmitter() {
  return {
    emit: vi.fn().mockResolvedValue("event-1"),
    emitStart: vi.fn(),
  } as unknown as AgentEventEmitter
}

async function buildTestApp(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    checkpointExists?: boolean
    checkpointCrc?: number
    checkpointState?: Record<string, unknown>
    enqueueJob?: (jobId: string) => Promise<void>
    eventEmitter?: AgentEventEmitter
  } = {},
) {
  const app = Fastify({ logger: false })
  const { db, updateExecute, insertedJob } = makeMockDb(opts)
  const enqueueJob = opts.enqueueJob ?? vi.fn().mockResolvedValue(undefined)
  const eventEmitter = opts.eventEmitter ?? makeMockEventEmitter()

  await app.register(
    agentControlRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
      enqueueJob,
      eventEmitter,
    }),
  )

  return { app, db, updateExecute, enqueueJob, eventEmitter, insertedJob }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/replay
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/replay", () => {
  it("creates a replay job from a valid checkpoint — returns 202", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.replayJobId).toBeDefined()
    expect(body.fromCheckpoint).toBe(CHECKPOINT_ID)
    expect(body.modifications).toBeNull()
  })

  it("passes modifications through to the response", async () => {
    const { app } = await buildTestApp()

    const modifications = {
      model: "claude-opus-4-20250514",
      systemPromptAppend: "Be extra verbose.",
    }

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID, modifications },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.modifications).toEqual(modifications)
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
    expect(res.json().message).toBe("Agent not found")
  })

  it("returns 404 when checkpoint does not exist", async () => {
    const { app } = await buildTestApp({ checkpointExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
    expect(res.json().message).toBe("Checkpoint not found")
  })

  it("returns 409 when checkpoint CRC is corrupted", async () => {
    const { app } = await buildTestApp({ checkpointCrc: 12345 })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
    expect(res.json().message).toContain("CRC mismatch")
  })

  it("returns 400 when checkpointId is missing", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("inserts a job with REPLAY type and checkpoint state", async () => {
    const { app, db } = await buildTestApp()

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(db.insertInto).toHaveBeenCalledWith("job")
    const insertCall = vi.mocked(db.insertInto).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>
    }
    const valuesArg = insertCall.values.mock.calls[0][0] as Record<string, unknown>
    expect(valuesArg.agent_id).toBe(AGENT_ID)
    expect(valuesArg.checkpoint).toEqual(VALID_STATE)
    expect(valuesArg.checkpoint_crc).toBe(VALID_CRC)
    const payload = valuesArg.payload as Record<string, unknown>
    expect(payload.type).toBe("REPLAY")
    expect(payload.replay_source_checkpoint_id).toBe(CHECKPOINT_ID)
  })

  it("enqueues the job via Graphile Worker", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(undefined)
    const { app } = await buildTestApp({ enqueueJob })

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    expect(enqueueJob).toHaveBeenCalledTimes(1)
  })

  it("emits replay_initiated event", async () => {
    const eventEmitter = makeMockEventEmitter()
    const { app } = await buildTestApp({ eventEmitter })

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: {
        checkpointId: CHECKPOINT_ID,
        modifications: { model: "claude-opus-4-20250514" },
      },
    })

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1)
    const emitArg = vi.mocked(eventEmitter.emit).mock.calls[0]![0] as Record<string, unknown>
    expect(emitArg.agentId).toBe(AGENT_ID)
    expect(emitArg.eventType).toBe("replay_initiated")
    expect(typeof emitArg.jobId).toBe("string")
    const emitPayload = emitArg.payload as Record<string, unknown>
    expect(emitPayload.replay_source_checkpoint_id).toBe(CHECKPOINT_ID)
    expect(emitPayload.modifications).toEqual({ model: "claude-opus-4-20250514" })
  })

  it("handles enqueueJob failure gracefully — job still created", async () => {
    const enqueueJob = vi.fn().mockRejectedValue(new Error("Worker unavailable"))
    const { app } = await buildTestApp({ enqueueJob })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/replay`,
      payload: { checkpointId: CHECKPOINT_ID },
    })

    // Should still succeed — job is in DB as SCHEDULED
    expect(res.statusCode).toBe(202)
    expect(enqueueJob).toHaveBeenCalledTimes(1)
  })
})
