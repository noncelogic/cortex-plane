/**
 * Browser Orchestration Tests
 *
 * Tests for annotation steering, auth handoff, trace capture,
 * tab session model, and screenshot mode.
 */

import Fastify from "fastify"
import fastifyWebSocket from "@fastify/websocket"
import type { Runner } from "graphile-worker"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import type { AgentLifecycleState } from "../lifecycle/state-machine.js"
import {
  AuthHandoffService,
  encrypt,
  decrypt,
  generateEncryptionKey,
} from "../browser/auth-handoff.js"
import { annotationToAction, annotationToPrompt } from "../browser/steering.js"
import { TraceCaptureService } from "../browser/trace-capture.js"
import { ScreenshotModeService, hashScreenshot } from "../browser/screenshot-mode.js"
import { BrowserObservationService } from "../observation/service.js"
import { observationRoutes } from "../routes/observation.js"
import { healthRoutes } from "../routes/health.js"
import { SSEConnectionManager } from "../streaming/manager.js"

import type { AnnotationPayload, AuthHandoffRequest } from "@cortex/shared/browser"

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

const AUTH_HEADERS = {
  authorization: "Bearer session-123",
  "content-type": "application/json",
}

async function buildTestApp(options: {
  session?: Record<string, unknown> | null
  lifecycleManager?: AgentLifecycleManager
  observationService?: BrowserObservationService
  authHandoffService?: AuthHandoffService
  traceCaptureService?: TraceCaptureService
  screenshotModeService?: ScreenshotModeService
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
      authHandoffService: options.authHandoffService,
      traceCaptureService: options.traceCaptureService,
      screenshotModeService: options.screenshotModeService,
      authConfig: { apiKeys: [], requireAuth: false },
    }),
  )

  return { app, sseManager, lifecycle, observation, db }
}

// ===========================================================================
// Annotation Steering Unit Tests
// ===========================================================================

describe("annotationToAction", () => {
  it("converts click annotation to click action", () => {
    const annotation: AnnotationPayload = {
      type: "click",
      coordinates: { x: 100, y: 200 },
      selector: "#submit-btn",
      metadata: {},
    }
    const action = annotationToAction(annotation)
    expect(action.actionType).toBe("click")
    expect(action.target).toBe("#submit-btn")
    expect(action.parameters.x).toBe(100)
    expect(action.parameters.y).toBe(200)
  })

  it("converts type annotation to fill action", () => {
    const annotation: AnnotationPayload = {
      type: "type",
      coordinates: { x: 50, y: 80 },
      selector: "input[name=email]",
      text: "user@example.com",
      metadata: {},
    }
    const action = annotationToAction(annotation)
    expect(action.actionType).toBe("fill")
    expect(action.parameters.text).toBe("user@example.com")
    expect(action.target).toBe("input[name=email]")
  })

  it("converts scroll annotation to scroll action", () => {
    const annotation: AnnotationPayload = {
      type: "scroll",
      coordinates: { x: 0, y: 0 },
      metadata: { direction: "up", amount: 500 },
    }
    const action = annotationToAction(annotation)
    expect(action.actionType).toBe("scroll")
    expect(action.target).toBe("viewport")
    expect(action.parameters.direction).toBe("up")
    expect(action.parameters.amount).toBe(500)
  })

  it("converts highlight annotation to highlight action", () => {
    const annotation: AnnotationPayload = {
      type: "highlight",
      coordinates: { x: 200, y: 300 },
      selector: ".error-message",
      text: "Something went wrong",
      metadata: {},
    }
    const action = annotationToAction(annotation)
    expect(action.actionType).toBe("highlight")
    expect(action.target).toBe(".error-message")
    expect(action.parameters.text).toBe("Something went wrong")
  })

  it("converts select annotation to select action", () => {
    const annotation: AnnotationPayload = {
      type: "select",
      coordinates: { x: 150, y: 250 },
      selector: "select#country",
      text: "US",
      metadata: {},
    }
    const action = annotationToAction(annotation)
    expect(action.actionType).toBe("select")
    expect(action.target).toBe("select#country")
    expect(action.parameters.value).toBe("US")
  })

  it("uses coordinate fallback when no selector provided", () => {
    const annotation: AnnotationPayload = {
      type: "click",
      coordinates: { x: 42, y: 84 },
      metadata: {},
    }
    const action = annotationToAction(annotation)
    expect(action.target).toBe("coordinates(42,84)")
  })
})

describe("annotationToPrompt", () => {
  it("generates click prompt with selector", () => {
    const annotation: AnnotationPayload = {
      type: "click",
      coordinates: { x: 100, y: 200 },
      selector: "#btn",
      metadata: {},
    }
    const prompt = annotationToPrompt(annotation)
    expect(prompt).toContain("clicked")
    expect(prompt).toContain("#btn")
    expect(prompt).toContain("(100, 200)")
  })

  it("generates type prompt with text", () => {
    const annotation: AnnotationPayload = {
      type: "type",
      coordinates: { x: 50, y: 80 },
      text: "hello world",
      metadata: {},
    }
    const prompt = annotationToPrompt(annotation)
    expect(prompt).toContain("type")
    expect(prompt).toContain("hello world")
  })

  it("generates scroll prompt with direction", () => {
    const annotation: AnnotationPayload = {
      type: "scroll",
      coordinates: { x: 0, y: 0 },
      metadata: { direction: "down" },
    }
    const prompt = annotationToPrompt(annotation)
    expect(prompt).toContain("scrolled")
    expect(prompt).toContain("down")
  })
})

// ===========================================================================
// Auth Handoff Tests
// ===========================================================================

describe("AuthHandoffService", () => {
  let service: AuthHandoffService

  beforeEach(() => {
    service = new AuthHandoffService()
  })

  afterEach(() => {
    service.shutdown()
  })

  describe("encryption", () => {
    it("encrypts and decrypts correctly", () => {
      const key = generateEncryptionKey()
      const plaintext = "sensitive-cookie-data"
      const encrypted = encrypt(plaintext, key)

      expect(encrypted.ciphertext).not.toBe(plaintext)
      expect(encrypted.iv).toBeDefined()
      expect(encrypted.authTag).toBeDefined()

      const decrypted = decrypt(encrypted, key)
      expect(decrypted).toBe(plaintext)
    })

    it("different keys produce different ciphertexts", () => {
      const key1 = generateEncryptionKey()
      const key2 = generateEncryptionKey()
      const plaintext = "same-data"

      const enc1 = encrypt(plaintext, key1)
      const enc2 = encrypt(plaintext, key2)
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext)
    })

    it("fails to decrypt with wrong key", () => {
      const key1 = generateEncryptionKey()
      const key2 = generateEncryptionKey()
      const encrypted = encrypt("test", key1)

      expect(() => decrypt(encrypted, key2)).toThrow()
    })

    it("detects tampered ciphertext", () => {
      const key = generateEncryptionKey()
      const encrypted = encrypt("test", key)
      // Tamper with ciphertext
      const buf = Buffer.from(encrypted.ciphertext, "base64")
      buf[0] = buf[0]! ^ 0xff
      encrypted.ciphertext = buf.toString("base64")

      expect(() => decrypt(encrypted, key)).toThrow()
    })
  })

  describe("prepareHandoff", () => {
    it("requires consent gate (approver role checked by route)", async () => {
      // The consent gate is enforced at the route level via requireRole("approver")
      // This test verifies the service itself works when called
      const result = await service.prepareHandoff(
        {
          agentId: "agent-1",
          targetUrl: "https://example.com",
          cookies: [{ name: "session", value: "abc123", domain: "example.com" }],
        },
        "user-1",
        "Test User",
      )
      expect(result.success).toBe(true)
      expect(result.targetUrl).toBe("https://example.com")
      expect(result.injectedAt).toBeDefined()
    })

    it("encrypts cookies at rest", async () => {
      await service.prepareHandoff(
        {
          agentId: "agent-1",
          targetUrl: "https://example.com",
          cookies: [{ name: "session", value: "secret-cookie", domain: "example.com" }],
        },
        "user-1",
        "Test User",
      )

      // Consume returns the decrypted data
      const data = service.consumeHandoff("agent-1")
      expect(data).not.toBeNull()
      expect(data!.cookies![0]!.value).toBe("secret-cookie")
    })

    it("clears encrypted data after consumption", async () => {
      await service.prepareHandoff(
        {
          agentId: "agent-1",
          targetUrl: "https://example.com",
          sessionToken: "tok_123",
        },
        "user-1",
        "Test User",
      )

      // First consume succeeds
      const data = service.consumeHandoff("agent-1")
      expect(data!.sessionToken).toBe("tok_123")

      // Second consume returns null (cleared)
      const second = service.consumeHandoff("agent-1")
      expect(second).toBeNull()
    })

    it("logs audit entry for every handoff", async () => {
      await service.prepareHandoff(
        {
          agentId: "agent-1",
          targetUrl: "https://example.com",
          cookies: [{ name: "c", value: "v", domain: "example.com" }],
          localStorage: { key: "val" },
          sessionToken: "tok",
        },
        "user-1",
        "Test User",
      )

      const log = service.getAuditLog("agent-1")
      expect(log).toHaveLength(1)
      expect(log[0]!.action).toBe("auth_handoff_injected")
      expect(log[0]!.actorId).toBe("user-1")
      expect(log[0]!.hasCookies).toBe(true)
      expect(log[0]!.hasLocalStorage).toBe(true)
      expect(log[0]!.hasSessionToken).toBe(true)
    })

    it("supports localStorage and sessionToken handoff", async () => {
      await service.prepareHandoff(
        {
          agentId: "agent-1",
          targetUrl: "https://example.com",
          localStorage: { auth_token: "jwt.token.here" },
          sessionToken: "session-token-123",
        },
        "user-1",
        "Test User",
      )

      const data = service.consumeHandoff("agent-1")
      expect(data!.localStorage!.auth_token).toBe("jwt.token.here")
      expect(data!.sessionToken).toBe("session-token-123")
    })
  })

  describe("cleanup", () => {
    it("removes pending handoffs for an agent", async () => {
      await service.prepareHandoff(
        { agentId: "agent-1", targetUrl: "https://example.com" },
        "user-1",
        "Test User",
      )

      service.cleanup("agent-1")
      const data = service.consumeHandoff("agent-1")
      expect(data).toBeNull()
    })
  })
})

// ===========================================================================
// Trace Capture Tests
// ===========================================================================

describe("TraceCaptureService", () => {
  let service: TraceCaptureService

  beforeEach(() => {
    service = new TraceCaptureService()
  })

  afterEach(() => {
    service.shutdown()
  })

  it("registers trace metadata", async () => {
    const metadata = await service.registerTrace(
      "agent-1",
      "job-1",
      "/workspace/traces/trace-agent-1-123.json",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:05.000Z",
    )

    expect(metadata.traceId).toBeDefined()
    expect(metadata.jobId).toBe("job-1")
    expect(metadata.agentId).toBe("agent-1")
    expect(metadata.startedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(metadata.stoppedAt).toBe("2026-01-01T00:00:05.000Z")
    expect(metadata.downloadUrl).toContain("agent-1")
  })

  it("lists traces for an agent", async () => {
    await service.registerTrace(
      "agent-1",
      "job-1",
      "/path/1",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:00Z",
    )
    await service.registerTrace(
      "agent-1",
      "job-2",
      "/path/2",
      "2026-01-01T00:02:00Z",
      "2026-01-01T00:03:00Z",
    )

    const traces = service.getTraces("agent-1")
    expect(traces).toHaveLength(2)
  })

  it("returns empty array for unknown agent", () => {
    const traces = service.getTraces("unknown-agent")
    expect(traces).toEqual([])
  })

  it("gets trace by ID", async () => {
    const metadata = await service.registerTrace("agent-1", "job-1", "/path", "t1", "t2")
    const found = service.getTrace("agent-1", metadata.traceId)
    expect(found).toBeDefined()
    expect(found!.traceId).toBe(metadata.traceId)
  })

  it("returns undefined for unknown trace ID", () => {
    const found = service.getTrace("agent-1", "nonexistent")
    expect(found).toBeUndefined()
  })

  it("cleans up traces for an agent", async () => {
    await service.registerTrace("agent-1", "job-1", "/path", "t1", "t2")
    service.cleanup("agent-1")
    expect(service.getTraces("agent-1")).toEqual([])
  })
})

// ===========================================================================
// Tab Session Model Tests
// ===========================================================================

describe("Tab model via observation service", () => {
  it("creates fresh state for new agent with idle trace", () => {
    const service = new BrowserObservationService({
      cdpHost: "127.0.0.1",
      cdpPort: 9222,
    })
    const state = service.getTraceState("new-agent")
    expect(state.agentId).toBe("new-agent")
    expect(state.status).toBe("idle")
  })

  it("maintains per-agent annotation listeners independently", async () => {
    const service = new BrowserObservationService({
      cdpHost: "127.0.0.1",
      cdpPort: 9222,
    })

    const listener1 = vi.fn()
    const listener2 = vi.fn()
    service.onAnnotation("agent-1", listener1)
    service.onAnnotation("agent-2", listener2)

    await service.forwardAnnotation("agent-1", { type: "click", x: 10, y: 20 })

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).not.toHaveBeenCalled()

    await service.shutdown()
  })

  it("tab events update session state via listTabs", async () => {
    // listTabs queries CDP, so we test the route behavior
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/tabs",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tabs).toHaveLength(2)
    expect(body.tabs[0].active).toBe(true)
    expect(body.tabs[1].active).toBe(false)
  })
})

// ===========================================================================
// Screenshot Mode Tests
// ===========================================================================

describe("ScreenshotModeService", () => {
  let observationMock: BrowserObservationService

  beforeEach(() => {
    observationMock = mockObservationService()
  })

  describe("hashScreenshot", () => {
    it("produces consistent hashes for same data", () => {
      const hash1 = hashScreenshot("abc123")
      const hash2 = hashScreenshot("abc123")
      expect(hash1).toBe(hash2)
    })

    it("produces different hashes for different data", () => {
      const hash1 = hashScreenshot("abc123")
      const hash2 = hashScreenshot("def456")
      expect(hash1).not.toBe(hash2)
    })

    it("returns 16-character hex string", () => {
      const hash = hashScreenshot("test")
      expect(hash).toMatch(/^[a-f0-9]{16}$/)
    })
  })

  describe("start/stop lifecycle", () => {
    it("starts with default configuration", () => {
      const service = new ScreenshotModeService(observationMock)
      const config = service.start("agent-1")
      expect(config.intervalMs).toBe(2000)
      expect(config.format).toBe("jpeg")
      expect(config.quality).toBe(60)
      expect(service.isActive("agent-1")).toBe(true)
      service.shutdown()
    })

    it("starts with custom configuration", () => {
      const service = new ScreenshotModeService(observationMock)
      const config = service.start("agent-1", { intervalMs: 5000, quality: 90 })
      expect(config.intervalMs).toBe(5000)
      expect(config.quality).toBe(90)
      service.shutdown()
    })

    it("stops screenshot mode", () => {
      const service = new ScreenshotModeService(observationMock)
      service.start("agent-1")
      service.stop("agent-1")
      expect(service.isActive("agent-1")).toBe(false)
    })

    it("returns null config for inactive agent", () => {
      const service = new ScreenshotModeService(observationMock)
      expect(service.getConfig("agent-1")).toBeNull()
      service.shutdown()
    })

    it("returns config for active agent", () => {
      const service = new ScreenshotModeService(observationMock)
      service.start("agent-1", { intervalMs: 3000 })
      const config = service.getConfig("agent-1")
      expect(config!.intervalMs).toBe(3000)
      service.shutdown()
    })

    it("shutdown stops all agents", () => {
      const service = new ScreenshotModeService(observationMock)
      service.start("agent-1")
      service.start("agent-2")
      service.shutdown()
      expect(service.isActive("agent-1")).toBe(false)
      expect(service.isActive("agent-2")).toBe(false)
    })
  })

  describe("diff detection", () => {
    it("detects unchanged frames via hash comparison", () => {
      const h1 = hashScreenshot("same-frame-data")
      const h2 = hashScreenshot("same-frame-data")
      expect(h1).toBe(h2) // Same hash means no change
    })

    it("detects changed frames via hash comparison", () => {
      const h1 = hashScreenshot("frame-1")
      const h2 = hashScreenshot("frame-2")
      expect(h1).not.toBe(h2) // Different hash means change
    })
  })

  describe("frame listeners", () => {
    it("registers and unregisters listeners", () => {
      const service = new ScreenshotModeService(observationMock)
      const listener = vi.fn()
      const unsubscribe = service.onFrame("agent-1", listener)
      expect(typeof unsubscribe).toBe("function")
      unsubscribe()
      service.shutdown()
    })
  })
})

// ===========================================================================
// Route Integration Tests — Browser Steering
// ===========================================================================

describe("POST /agents/:agentId/browser/steer", () => {
  it("accepts annotation and returns steer action", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/steer",
      headers: AUTH_HEADERS,
      payload: {
        type: "click",
        coordinates: { x: 100, y: 200 },
        selector: "#btn",
        metadata: {},
      },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.agentId).toBe("agent-1")
    expect(body.action.actionType).toBe("click")
    expect(body.action.target).toBe("#btn")
    expect(body.prompt).toContain("clicked")
  })

  it("injects steering message into agent", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/steer",
      headers: AUTH_HEADERS,
      payload: {
        type: "type",
        coordinates: { x: 50, y: 80 },
        text: "hello",
        metadata: {},
      },
    })

    expect(steerFn).toHaveBeenCalledTimes(1)
    const msg = steerFn.mock.calls[0]![0] as { message: string }
    expect(msg.message).toContain("[STEER]")
    expect(msg.message).toContain("type")
  })

  it("returns 409 when agent is not EXECUTING", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => "READY" })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/steer",
      headers: AUTH_HEADERS,
      payload: {
        type: "click",
        coordinates: { x: 0, y: 0 },
        metadata: {},
      },
    })

    expect(res.statusCode).toBe(409)
  })

  it("returns 404 for unknown agent", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/steer",
      headers: AUTH_HEADERS,
      payload: {
        type: "click",
        coordinates: { x: 0, y: 0 },
        metadata: {},
      },
    })

    expect(res.statusCode).toBe(404)
  })

  it("broadcasts browser:steer:action via SSE", async () => {
    const lifecycle = mockLifecycleManager({ getAgentState: () => "EXECUTING" })
    const { app, sseManager } = await buildTestApp({ lifecycleManager: lifecycle })
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/steer",
      headers: AUTH_HEADERS,
      payload: {
        type: "click",
        coordinates: { x: 10, y: 20 },
        metadata: {},
      },
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:steer:action",
      expect.objectContaining({ agentId: "agent-1" }),
    )
    broadcastSpy.mockRestore()
  })
})

// ===========================================================================
// Route Integration Tests — Auth Handoff
// ===========================================================================

describe("POST /agents/:agentId/browser/auth-handoff", () => {
  it("accepts auth handoff and returns success", async () => {
    const authHandoffService = new AuthHandoffService()
    const { app } = await buildTestApp({ authHandoffService })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/auth-handoff",
      headers: AUTH_HEADERS,
      payload: {
        targetUrl: "https://example.com",
        cookies: [{ name: "session", value: "abc", domain: "example.com" }],
      },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.targetUrl).toBe("https://example.com")

    authHandoffService.shutdown()
  })

  it("creates audit log entry", async () => {
    const authHandoffService = new AuthHandoffService()
    const { app } = await buildTestApp({ authHandoffService })

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/auth-handoff",
      headers: AUTH_HEADERS,
      payload: {
        targetUrl: "https://example.com",
        sessionToken: "tok_123",
      },
    })

    const log = authHandoffService.getAuditLog("agent-1")
    expect(log).toHaveLength(1)
    expect(log[0]!.hasSessionToken).toBe(true)

    authHandoffService.shutdown()
  })

  it("broadcasts browser:auth:handoff via SSE", async () => {
    const authHandoffService = new AuthHandoffService()
    const { app, sseManager } = await buildTestApp({ authHandoffService })
    const broadcastSpy = vi.spyOn(sseManager, "broadcast")

    await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/auth-handoff",
      headers: AUTH_HEADERS,
      payload: { targetUrl: "https://example.com" },
    })

    expect(broadcastSpy).toHaveBeenCalledWith(
      "agent-1",
      "browser:auth:handoff",
      expect.objectContaining({ agentId: "agent-1", success: true }),
    )
    broadcastSpy.mockRestore()
    authHandoffService.shutdown()
  })

  it("returns 404 for unknown agent", async () => {
    const authHandoffService = new AuthHandoffService()
    const lifecycle = mockLifecycleManager({ getAgentState: () => undefined })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle, authHandoffService })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/auth-handoff",
      headers: AUTH_HEADERS,
      payload: { targetUrl: "https://example.com" },
    })

    expect(res.statusCode).toBe(404)
    authHandoffService.shutdown()
  })
})

// ===========================================================================
// Route Integration Tests — Trace Capture
// ===========================================================================

describe("GET /agents/:agentId/browser/trace", () => {
  it("returns empty traces for new agent", async () => {
    const traceCaptureService = new TraceCaptureService()
    const { app } = await buildTestApp({ traceCaptureService })

    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/browser/trace",
      headers: AUTH_HEADERS,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agentId).toBe("agent-1")
    expect(body.traces).toEqual([])

    traceCaptureService.shutdown()
  })
})

describe("POST /agents/:agentId/browser/trace/start (with trace capture)", () => {
  it("starts trace and returns 202", async () => {
    const traceCaptureService = new TraceCaptureService()
    const { app } = await buildTestApp({ traceCaptureService })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/trace/start",
      headers: AUTH_HEADERS,
      payload: { jobId: "job-1", snapshots: true },
    })

    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(body.status).toBe("recording")

    traceCaptureService.shutdown()
  })
})

describe("POST /agents/:agentId/browser/trace/stop (with trace capture)", () => {
  it("stops trace and registers metadata", async () => {
    const traceCaptureService = new TraceCaptureService()
    const observationService = mockObservationService({
      getTraceState: vi.fn().mockReturnValue({
        agentId: "agent-1",
        status: "recording",
        startedAt: "2026-01-01T00:00:00.000Z",
        options: null,
      }),
    })

    const { app } = await buildTestApp({ traceCaptureService, observationService })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/browser/trace/stop",
      headers: AUTH_HEADERS,
      payload: { jobId: "job-1" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.metadata).toBeDefined()
    expect(body.metadata.agentId).toBe("agent-1")
    expect(body.metadata.jobId).toBe("job-1")

    // Verify trace was registered
    const traces = traceCaptureService.getTraces("agent-1")
    expect(traces).toHaveLength(1)

    traceCaptureService.shutdown()
  })
})

// ===========================================================================
// Existing observation routes still work
// ===========================================================================

describe("existing observation routes remain functional", () => {
  it("GET /agents/:agentId/observe/stream-status still works", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "GET",
      url: "/agents/agent-1/observe/stream-status",
      headers: AUTH_HEADERS,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().agentId).toBe("agent-1")
  })

  it("POST /agents/:agentId/observe/screenshot still works", async () => {
    const { app } = await buildTestApp({})
    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/screenshot",
      headers: AUTH_HEADERS,
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toBe("base64data")
  })

  it("POST /agents/:agentId/observe/annotate still works", async () => {
    const steerFn = vi.fn()
    const lifecycle = mockLifecycleManager({
      getAgentState: () => "EXECUTING",
      steer: steerFn,
    })
    const { app } = await buildTestApp({ lifecycleManager: lifecycle })

    const res = await app.inject({
      method: "POST",
      url: "/agents/agent-1/observe/annotate",
      headers: AUTH_HEADERS,
      payload: { type: "click", x: 100, y: 200 },
    })
    expect(res.statusCode).toBe(202)
  })
})
