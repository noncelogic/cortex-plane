import Fastify from "fastify"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import type { AgentLifecycleState } from "../lifecycle/state-machine.js"
import { healthRoutes } from "../routes/health.js"
import { streamRoutes } from "../routes/stream.js"
import { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Kysely db that supports the chained query pattern:
 * db.selectFrom("session").select([...]).where(...).where(...).executeTakeFirst()
 */
function mockDb(sessionRow?: Record<string, unknown> | null) {
  const executeTakeFirst = vi.fn().mockResolvedValue(sessionRow ?? null)

  // Build the chain from the end backwards
  const whereSecond = vi.fn().mockReturnValue({ executeTakeFirst })
  const whereFirst = vi.fn().mockReturnValue({ where: whereSecond })
  const selectFn = vi.fn().mockReturnValue({ where: whereFirst })
  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session") {
      return { select: selectFn }
    }
    // For health check route
    return {
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          execute: vi.fn().mockResolvedValue([]),
        }),
      }),
    }
  })

  return { selectFrom: selectFromFn } as unknown as Kysely<Database>
}

function mockLifecycleManager(
  overrides: {
    getAgentState?: (agentId: string) => AgentLifecycleState | undefined
    steer?: (msg: unknown) => void
  } = {},
): AgentLifecycleManager {
  return {
    getAgentState: overrides.getAgentState ?? (() => "EXECUTING"),
    getAgentContext: vi.fn(),
    steer: overrides.steer ?? vi.fn(),
  } as unknown as AgentLifecycleManager
}

const VALID_SESSION = {
  id: "session-123",
  agent_id: "agent-1",
  user_account_id: "user-1",
  status: "active",
}

async function buildTestApp(options: {
  session?: Record<string, unknown> | null
  lifecycleManager?: AgentLifecycleManager
}) {
  const app = Fastify({ logger: false })
  const db = mockDb("session" in options ? options.session : VALID_SESSION)
  const sseManager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
  const lifecycle = options.lifecycleManager ?? mockLifecycleManager()

  app.decorate("worker", {} as Runner)
  app.decorate("db", db)

  await app.register(healthRoutes)
  await app.register(streamRoutes({ sseManager, lifecycleManager: lifecycle }))

  return { app, sseManager, lifecycle, db }
}

// ---------------------------------------------------------------------------
// Tests: Authentication (using POST /steer which doesn't hijack)
// ---------------------------------------------------------------------------

describe("stream route authentication", () => {
  it("returns 401 without Authorization header", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      payload: { message: "test" },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json<{ error: string }>().error).toBe("unauthorized")
  })

  it("returns 401 with invalid token format", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: { authorization: "Basic abc123" },
      payload: { message: "test" },
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 401 with empty bearer token", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: { authorization: "Bearer " },
      payload: { message: "test" },
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 401 when session not found", async () => {
    const { app } = await buildTestApp({ session: null })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer nonexistent-token",
        "content-type": "application/json",
      },
      payload: { message: "test" },
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 403 when session agent_id does not match", async () => {
    const { app } = await buildTestApp({
      session: { ...VALID_SESSION, agent_id: "different-agent" },
    })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "test" },
    })

    expect(res.statusCode).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/stream — error cases (non-hijacking paths)
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/stream", () => {
  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({
      getAgentState: () => undefined,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/stream",
      headers: { authorization: "Bearer session-123" },
    })

    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: string }>().error).toBe("not_found")
  })

  it("returns 410 when agent is terminated", async () => {
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "TERMINATED",
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/stream",
      headers: { authorization: "Bearer session-123" },
    })

    expect(res.statusCode).toBe(410)
    expect(res.json<{ error: string }>().error).toBe("gone")
  })

  it("returns 401 without auth for stream endpoint", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/stream",
    })

    expect(res.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/steer
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/steer", () => {
  it("returns 401 without auth", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      payload: { message: "focus on tests" },
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({
      getAgentState: () => undefined,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 409 when agent is not in EXECUTING state", async () => {
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "READY",
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: string }>().error).toBe("conflict")
  })

  it("returns 202 with steerMessageId on success", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json<{
      status: string
      steerMessageId: string
      agentId: string
      priority: string
    }>()
    expect(body.status).toBe("accepted")
    expect(body.steerMessageId).toBeDefined()
    expect(body.agentId).toBe("agent-1")
    expect(body.priority).toBe("normal")
  })

  it("passes steering message to lifecycle manager", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests", priority: "high" },
    })

    expect(steerFn).toHaveBeenCalledTimes(1)
    const msg = steerFn.mock.calls[0]![0] as {
      agentId: string
      message: string
      priority: string
      id: string
    }
    expect(msg.agentId).toBe("agent-1")
    expect(msg.message).toBe("focus on tests")
    expect(msg.priority).toBe("high")
    expect(msg.id).toBeDefined()
  })

  it("returns 409 if lifecycle.steer throws", async () => {
    const steerFn = vi.fn().mockImplementation(() => {
      throw new Error("Agent not in EXECUTING state")
    })
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    expect(res.statusCode).toBe(409)
  })

  it("validates message is required", async () => {
    const { app } = await buildTestApp({})

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })

  it("uses default priority when not specified", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    expect(res.json<{ priority: string }>().priority).toBe("normal")
    expect((steerFn.mock.calls[0]![0] as { priority: string }).priority).toBe("normal")
  })

  it("broadcasts steer:ack and agent:output events on success", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app, sseManager } = await buildTestApp({ lifecycleManager: lifecycle })

    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/steer",
      headers: {
        authorization: "Bearer session-123",
        "content-type": "application/json",
      },
      payload: { message: "focus on tests" },
    })

    // Should have broadcast steer:ack and agent:output
    expect(broadcastSpy).toHaveBeenCalledTimes(2)
    expect(broadcastSpy.mock.calls[0]![1]).toBe("steer:ack")
    expect(broadcastSpy.mock.calls[1]![1]).toBe("agent:output")

    // Verify the output event contains the steering message
    const outputPayload = broadcastSpy.mock.calls[1]![2] as Record<string, unknown>
    const output = outputPayload.output as Record<string, unknown>
    expect(output.content).toContain("[STEER] focus on tests")

    broadcastSpy.mockRestore()
  })
})
