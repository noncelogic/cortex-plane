/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method */
import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import type { AgentEventEmitter } from "../observability/event-emitter.js"
import { ExecutionRegistry } from "../observability/execution-registry.js"
import { agentControlRoutes } from "../routes/agent-control.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const JOB_ID = "job-11111111-2222-3333-4444-555555555555"

function makeMockDb(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    runningJobId?: string | null
  } = {},
) {
  const { agentExists = true, agentStatus = "ACTIVE", runningJobId = null } = opts

  const agentRow = agentExists ? { id: AGENT_ID, status: agentStatus } : null
  const jobRow = runningJobId ? { id: runningJobId } : null

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
      if (table === "job") {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(jobRow),
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

    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ id: "event-1" }),
        }),
      }),
    }),
  } as unknown as Kysely<Database>

  return { db, updateExecute }
}

function makeMockEventEmitter() {
  return {
    emit: vi.fn().mockResolvedValue("event-1"),
    emitStart: vi.fn(),
  } as unknown as AgentEventEmitter
}

function makeMockSseManager() {
  return {
    broadcast: vi.fn().mockReturnValue({ id: "sse-1", event: "agent:killed", data: "{}" }),
  } as unknown as SSEConnectionManager
}

async function buildTestApp(
  opts: {
    agentExists?: boolean
    agentStatus?: string
    runningJobId?: string | null
    executionRegistry?: ExecutionRegistry
    eventEmitter?: AgentEventEmitter
    sseManager?: SSEConnectionManager
  } = {},
) {
  const { agentExists = true, agentStatus = "ACTIVE", runningJobId = null } = opts

  const app = Fastify({ logger: false })
  const { db, updateExecute } = makeMockDb({ agentExists, agentStatus, runningJobId })
  const executionRegistry = opts.executionRegistry ?? new ExecutionRegistry()
  const eventEmitter = opts.eventEmitter ?? makeMockEventEmitter()
  const sseManager = opts.sseManager ?? makeMockSseManager()

  await app.register(
    agentControlRoutes({
      db,
      authConfig: DEV_AUTH_CONFIG,
      executionRegistry,
      eventEmitter,
      sseManager,
    }),
  )

  return { app, db, updateExecute, executionRegistry, eventEmitter, sseManager }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/kill
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/kill", () => {
  it("kills an idle agent (no running job) — agent quarantined", async () => {
    const { app, updateExecute } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Emergency shutdown" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.previousState).toBe("ACTIVE")
    expect(body.cancelledJobId).toBeNull()
    expect(body.state).toBe("QUARANTINED")
    expect(body.killedAt).toBeDefined()
    expect(updateExecute).toHaveBeenCalled()
  })

  it("kills an executing agent — running job cancelled, agent quarantined", async () => {
    const registry = new ExecutionRegistry()
    const cancelFn = vi.fn().mockResolvedValue(undefined)
    registry.register(JOB_ID, {
      taskId: JOB_ID,
      cancel: cancelFn,
      events: () => (async function* () {})(),
      result: () => Promise.resolve({} as never),
    })

    const { app } = await buildTestApp({
      runningJobId: JOB_ID,
      executionRegistry: registry,
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Cost overrun" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe(AGENT_ID)
    expect(body.previousState).toBe("ACTIVE")
    expect(body.cancelledJobId).toBe(JOB_ID)
    expect(body.state).toBe("QUARANTINED")
    expect(cancelFn).toHaveBeenCalledWith("Cost overrun")
  })

  it("returns 409 when agent is already quarantined", async () => {
    const { app } = await buildTestApp({ agentStatus: "QUARANTINED" })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "test" },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("conflict")
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "test" },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe("not_found")
  })

  it("returns 400 when reason is missing", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("emits kill_requested event to agent_event", async () => {
    const eventEmitter = makeMockEventEmitter()
    const { app } = await buildTestApp({ eventEmitter })

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Operator intervention" },
    })

    expect(eventEmitter.emit).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      jobId: null,
      eventType: "kill_requested",
      payload: { reason: "Operator intervention", cancelledJobId: null },
    })
  })

  it("emits kill_requested event with cancelledJobId when job was running", async () => {
    const eventEmitter = makeMockEventEmitter()
    const { app } = await buildTestApp({
      runningJobId: JOB_ID,
      eventEmitter,
    })

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Cost overrun" },
    })

    expect(eventEmitter.emit).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      jobId: JOB_ID,
      eventType: "kill_requested",
      payload: { reason: "Cost overrun", cancelledJobId: JOB_ID },
    })
  })

  it("broadcasts agent:killed SSE event to connected clients", async () => {
    const sseManager = makeMockSseManager()
    const { app } = await buildTestApp({ sseManager })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Manual kill" },
    })

    const body = res.json()
    expect(sseManager.broadcast).toHaveBeenCalledWith(AGENT_ID, "agent:killed", {
      agentId: AGENT_ID,
      previousState: "ACTIVE",
      cancelledJobId: null,
      state: "QUARANTINED",
      reason: "Manual kill",
      killedAt: body.killedAt,
    })
  })

  it("cancels in-flight execution via ExecutionRegistry", async () => {
    const registry = new ExecutionRegistry()
    const cancelFn = vi.fn().mockResolvedValue(undefined)
    registry.register(JOB_ID, {
      taskId: JOB_ID,
      cancel: cancelFn,
      events: () => (async function* () {})(),
      result: () => Promise.resolve({} as never),
    })

    const { app } = await buildTestApp({
      runningJobId: JOB_ID,
      executionRegistry: registry,
    })

    await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/kill`,
      payload: { reason: "Abort" },
    })

    expect(cancelFn).toHaveBeenCalledWith("Abort")
    expect(registry.size).toBe(1) // registry.cancel doesn't unregister
  })
})
