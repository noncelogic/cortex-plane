import fastifyWebSocket from "@fastify/websocket"
import Fastify from "fastify"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import type { AgentLifecycleState } from "../lifecycle/state-machine.js"
import { BrowserObservationService } from "../observation/service.js"
import { healthRoutes } from "../routes/health.js"
import { observationRoutes } from "../routes/observation.js"
import { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDb(sessionRow?: Record<string, unknown> | null) {
  const executeTakeFirst = vi.fn().mockResolvedValue(sessionRow ?? null)
  const whereSecond = vi.fn().mockReturnValue({ executeTakeFirst })
  const whereFirst = vi.fn().mockReturnValue({ where: whereSecond })
  const selectFn = vi.fn().mockReturnValue({ where: whereFirst })
  const selectFromFn = vi.fn().mockImplementation((table: string) => {
    if (table === "session") {
      return { select: selectFn }
    }
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

function mockObservationService(
  overrides: Partial<Record<keyof BrowserObservationService, unknown>> = {},
): BrowserObservationService {
  return {
    getStreamStatus: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      quality: "degraded",
      fps: 0,
      lastFrameAt: null,
      vncEndpoint: null,
    }),
    getVncEndpoint: vi.fn().mockResolvedValue(null),
    proxyVncWebSocket: vi.fn(),
    captureScreenshot: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      data: "base64data",
      format: "jpeg",
      width: 1280,
      height: 720,
      timestamp: "2026-01-01T00:00:00.000Z",
      url: "https://example.com",
      title: "Example Page",
    }),
    listTabs: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      tabs: [
        { index: 0, url: "https://example.com", title: "Example", active: true },
        { index: 1, url: "https://other.com", title: "Other", active: false },
      ],
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    getTraceState: vi.fn().mockReturnValue({
      agentId: "agent-1",
      status: "idle",
      startedAt: null,
      options: null,
    }),
    startTrace: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      status: "recording",
      startedAt: "2026-01-01T00:00:00.000Z",
      options: { snapshots: true, screenshots: true, network: true, console: true },
    }),
    stopTrace: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      filePath: "/workspace/traces/trace-agent-1-123.json",
      sizeBytes: 4096,
      durationMs: 5000,
      timestamp: "2026-01-01T00:00:05.000Z",
    }),
    forwardAnnotation: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      annotationId: "annot-123",
      forwarded: true,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    onAnnotation: vi.fn().mockReturnValue(() => {}),
    cleanup: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BrowserObservationService
}

const VALID_SESSION = {
  id: "session-123",
  agent_id: "agent-1",
  user_account_id: "user-1",
  status: "active",
}

const AUTH_HEADER = { authorization: "Bearer session-123" }

const AUTH_HEADERS = {
  ...AUTH_HEADER,
  "content-type": "application/json",
}

async function buildTestApp(options: {
  session?: Record<string, unknown> | null
  lifecycleManager?: AgentLifecycleManager
  observationService?: BrowserObservationService
}) {
  const app = Fastify({ logger: false })
  const db = mockDb("session" in options ? options.session : VALID_SESSION)
  const sseManager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
  const lifecycle = options.lifecycleManager ?? mockLifecycleManager()
  const observation = options.observationService ?? mockObservationService()

  app.decorate("worker", {} as Runner)
  app.decorate("db", db)

  await app.register(fastifyWebSocket)
  await app.register(healthRoutes)
  await app.register(
    observationRoutes({
      sseManager,
      lifecycleManager: lifecycle,
      observationService: observation,
    }),
  )

  return { app, sseManager, lifecycle, observation, db }
}

// ---------------------------------------------------------------------------
// Tests: Authentication (shared across all observation endpoints)
// ---------------------------------------------------------------------------

describe("observation route authentication", () => {
  it("returns 401 without Authorization header", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/stream-status",
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ error: string }>().error).toBe("unauthorized")
  })

  it("returns 401 with invalid session", async () => {
    const { app } = await buildTestApp({ session: null })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: {},
    })
    expect(res.statusCode).toBe(401)
  })

  it("returns 403 when session agent_id does not match", async () => {
    const { app } = await buildTestApp({
      session: { ...VALID_SESSION, agent_id: "different-agent" },
    })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/tabs",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/observe/stream-status
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/observe/stream-status", () => {
  it("returns stream status for a live agent", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/stream-status",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ agentId: string; quality: string }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.quality).toBeDefined()
  })

  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/stream-status",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(404)
  })

  it("returns 410 when agent is terminated", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => "TERMINATED" })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/stream-status",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(410)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/observe/screenshot
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/observe/screenshot", () => {
  it("returns screenshot result on success", async () => {
    const { app, observation } = await buildTestApp({})
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: { format: "jpeg", quality: 80 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ agentId: string; data: string; format: string }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.data).toBe("base64data")
    expect(body.format).toBe("jpeg")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(observation.captureScreenshot).toHaveBeenCalledWith("agent-1", {
      format: "jpeg",
      quality: 80,
    })
  })

  it("returns 502 when screenshot capture fails", async () => {
    const observation = mockObservationService({
      captureScreenshot: vi.fn().mockRejectedValue(new Error("CDP connection refused")),
    })
    const { app } = await buildTestApp({ observationService: observation })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: {},
    })
    expect(res.statusCode).toBe(502)
    expect(res.json<{ error: string }>().error).toBe("upstream_error")
  })

  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it("broadcasts browser:screenshot event via SSE", async () => {
    const { app, sseManager } = await buildTestApp({})
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: {},
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:screenshot",
      expect.objectContaining({ agentId: "agent-1" }),
    )
    broadcastSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/observe/tabs
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/observe/tabs", () => {
  it("returns tab list on success", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/tabs",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ agentId: string; tabs: { active: boolean; url: string }[] }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.tabs).toHaveLength(2)
    expect(body.tabs[0].active).toBe(true)
    expect(body.tabs[1].url).toBe("https://other.com")
  })

  it("returns 502 when tab listing fails", async () => {
    const observation = mockObservationService({
      listTabs: vi.fn().mockRejectedValue(new Error("No browser page found")),
    })
    const { app } = await buildTestApp({ observationService: observation })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/tabs",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(502)
  })

  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/tabs",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/observe/trace
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/observe/trace", () => {
  it("returns trace state", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/trace",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ agentId: string; status: string }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.status).toBe("idle")
  })

  it("returns 404 when agent is not found", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/trace",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/observe/trace/start
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/observe/trace/start", () => {
  it("starts trace recording and returns 202", async () => {
    const { app, observation } = await buildTestApp({})
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/start",
      headers: AUTH_HEADERS,
      payload: { snapshots: true, network: true },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ status: string }>()
    expect(body.status).toBe("recording")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(observation.startTrace).toHaveBeenCalledWith("agent-1", {
      snapshots: true,
      network: true,
    })
  })

  it("returns 409 when trace is already recording", async () => {
    const observation = mockObservationService({
      startTrace: vi
        .fn()
        .mockRejectedValue(new Error("Trace recording already in progress for agent agent-1")),
    })
    const { app } = await buildTestApp({ observationService: observation })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/start",
      headers: AUTH_HEADERS,
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: string }>().error).toBe("conflict")
  })

  it("broadcasts browser:trace:state event via SSE", async () => {
    const { app, sseManager } = await buildTestApp({})
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/start",
      headers: AUTH_HEADERS,
      payload: {},
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:trace:state",
      expect.objectContaining({ agentId: "agent-1", status: "recording" }),
    )
    broadcastSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/observe/trace/stop
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/observe/trace/stop", () => {
  it("stops trace recording and returns download info", async () => {
    const { app, observation } = await buildTestApp({})
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/stop",
      headers: AUTH_HEADER,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ agentId: string; filePath: string; sizeBytes: number }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.filePath).toContain("trace-agent-1")
    expect(body.sizeBytes).toBe(4096)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(observation.stopTrace).toHaveBeenCalledWith("agent-1")
  })

  it("returns 409 when no active trace recording", async () => {
    const observation = mockObservationService({
      stopTrace: vi
        .fn()
        .mockRejectedValue(new Error("No active trace recording for agent agent-1")),
    })
    const { app } = await buildTestApp({ observationService: observation })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/stop",
      headers: AUTH_HEADER,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: string }>().error).toBe("conflict")
  })

  it("broadcasts browser:trace:state idle event via SSE", async () => {
    const { app, sseManager } = await buildTestApp({})
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/trace/stop",
      headers: AUTH_HEADER,
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:trace:state",
      expect.objectContaining({ agentId: "agent-1", status: "idle" }),
    )
    broadcastSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/observe/annotate
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/observe/annotate", () => {
  it("forwards annotation and returns 202", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app, observation } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200 },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ agentId: string; annotationId: string; forwarded: boolean }>()
    expect(body.agentId).toBe("agent-1")
    expect(body.annotationId).toBeDefined()
    expect(body.forwarded).toBe(true)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(observation.forwardAnnotation).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ type: "click", x: 100, y: 200 }),
    )
  })

  it("generates coordinate-based prompt when no prompt provided", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200, selector: "#btn" },
    })

    expect(steerFn).toHaveBeenCalledTimes(1)
    const msg = steerFn.mock.calls[0]![0] as { message: string }
    expect(msg.message).toContain("[ANNOTATION]")
    expect(msg.message).toContain("(100, 200)")
    expect(msg.message).toContain("#btn")
  })

  it("uses custom prompt when provided", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200, prompt: "Click the submit button" },
    })

    const msg = steerFn.mock.calls[0]![0] as { message: string }
    expect(msg.message).toContain("[ANNOTATION] Click the submit button")
  })

  it("returns 409 when agent is not EXECUTING", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => "READY" })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200 },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: string }>().error).toBe("conflict")
  })

  it("validates required fields", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click" }, // missing x, y
    })
    expect(res.statusCode).toBe(400)
  })

  it("broadcasts browser:annotation:ack event via SSE", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app, sseManager } = await buildTestApp({ lifecycleManager: lifecycle })
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200 },
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:annotation:ack",
      expect.objectContaining({
        agentId: "agent-1",
        annotationId: "annot-123",
      }),
    )
    broadcastSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: BrowserObservationService unit tests
// ---------------------------------------------------------------------------

describe("BrowserObservationService", () => {
  let service: BrowserObservationService

  beforeEach(() => {
    service = new BrowserObservationService({
      cdpHost: "127.0.0.1",
      cdpPort: 9222,
      websockifyPort: 6080,
      vncPort: 5900,
    })
  })

  afterEach(async () => {
    await service.shutdown()
  })

  describe("getTraceState", () => {
    it("returns idle state for new agent", () => {
      const state = service.getTraceState("agent-new")
      expect(state.agentId).toBe("agent-new")
      expect(state.status).toBe("idle")
      expect(state.startedAt).toBeNull()
      expect(state.options).toBeNull()
    })
  })

  describe("forwardAnnotation", () => {
    it("returns result with no listeners", async () => {
      const result = await service.forwardAnnotation("agent-1", {
        type: "click",
        x: 100,
        y: 200,
      })
      expect(result.agentId).toBe("agent-1")
      expect(result.annotationId).toBeDefined()
      expect(result.forwarded).toBe(false)
    })

    it("notifies registered listeners", async () => {
      const listener = vi.fn()
      service.onAnnotation("agent-1", listener)

      await service.forwardAnnotation("agent-1", {
        type: "click",
        x: 100,
        y: 200,
        prompt: "test",
      })

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "click", x: 100, y: 200, prompt: "test" }),
      )
    })

    it("returns forwarded=true when listeners exist", async () => {
      service.onAnnotation("agent-1", vi.fn())

      const result = await service.forwardAnnotation("agent-1", {
        type: "click",
        x: 10,
        y: 20,
      })
      expect(result.forwarded).toBe(true)
    })

    it("unsubscribes listener on dispose", async () => {
      const listener = vi.fn()
      const dispose = service.onAnnotation("agent-1", listener)
      dispose()

      const result = await service.forwardAnnotation("agent-1", {
        type: "click",
        x: 10,
        y: 20,
      })
      expect(listener).not.toHaveBeenCalled()
      expect(result.forwarded).toBe(false)
    })
  })

  describe("cleanup", () => {
    it("removes agent state", async () => {
      // Create some state
      service.getTraceState("agent-cleanup")
      await service.cleanup("agent-cleanup")

      // State should be fresh now (re-created on access)
      const state = service.getTraceState("agent-cleanup")
      expect(state.status).toBe("idle")
    })
  })
})
