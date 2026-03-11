import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FeedbackService } from "../feedback/service.js"
import { hashApiKey } from "../middleware/api-keys.js"
import type { AuthConfig } from "../middleware/types.js"
import { feedbackRoutes } from "../routes/feedback.js"

// ---------------------------------------------------------------------------
// Test keys & auth config
// ---------------------------------------------------------------------------

const OPERATOR_KEY = "sk-operator-feedback-test"

const authConfig: AuthConfig = {
  apiKeys: [
    {
      keyHash: hashApiKey(OPERATOR_KEY),
      userId: "user-operator",
      roles: ["operator"],
      label: "Operator Key",
    },
  ],
  requireAuth: true,
}

// ---------------------------------------------------------------------------
// Mock FeedbackService
// ---------------------------------------------------------------------------

function createMockFeedbackService() {
  return {
    listFeedback: vi.fn().mockResolvedValue([]),
    createFeedback: vi.fn().mockResolvedValue({ id: "fb-1", summary: "test" }),
    getFeedback: vi.fn().mockResolvedValue({ id: "fb-1", summary: "test" }),
    updateRemediation: vi.fn().mockResolvedValue({ id: "fb-1", status: "resolved" }),
    getActions: vi.fn().mockResolvedValue([]),
    addAction: vi.fn().mockResolvedValue({ id: "action-1", actionType: "note" }),
  } as unknown as FeedbackService
}

// ---------------------------------------------------------------------------
// Tests — auth required
// ---------------------------------------------------------------------------

describe("Feedback routes with auth", () => {
  let app: FastifyInstance
  let mockService: ReturnType<typeof createMockFeedbackService>

  beforeEach(async () => {
    app = Fastify({ logger: false })
    mockService = createMockFeedbackService()

    await app.register(
      feedbackRoutes({
        feedbackService: mockService as unknown as FeedbackService,
        authConfig,
      }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /api/feedback
  // -------------------------------------------------------------------------
  describe("GET /api/feedback", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/feedback" })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with valid auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/feedback",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/feedback
  // -------------------------------------------------------------------------
  describe("POST /api/feedback", () => {
    const body = {
      source: "agent",
      category: "error",
      severity: "medium",
      summary: "test feedback",
    }

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "POST", url: "/api/feedback", payload: body })
      expect(res.statusCode).toBe(401)
    })

    it("returns 201 with valid auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/feedback",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: body,
      })
      expect(res.statusCode).toBe(201)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/feedback/:id
  // -------------------------------------------------------------------------
  describe("GET /api/feedback/:id", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/feedback/fb-1" })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with valid auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/feedback/fb-1",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /api/feedback/:id
  // -------------------------------------------------------------------------
  describe("PATCH /api/feedback/:id", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/feedback/fb-1",
        payload: { status: "resolved" },
      })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with valid auth", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/feedback/fb-1",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { status: "resolved" },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/feedback/:id/actions
  // -------------------------------------------------------------------------
  describe("POST /api/feedback/:id/actions", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/feedback/fb-1/actions",
        payload: { actionType: "note", description: "test" },
      })
      expect(res.statusCode).toBe(401)
    })

    it("returns 201 with valid auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/feedback/fb-1/actions",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { actionType: "note", description: "test" },
      })
      expect(res.statusCode).toBe(201)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — dev mode (no auth)
// ---------------------------------------------------------------------------

describe("Feedback routes in dev mode (no auth)", () => {
  const devConfig: AuthConfig = {
    apiKeys: [],
    requireAuth: false,
  }

  let app: FastifyInstance
  let mockService: ReturnType<typeof createMockFeedbackService>

  beforeEach(async () => {
    app = Fastify({ logger: false })
    mockService = createMockFeedbackService()

    await app.register(
      feedbackRoutes({
        feedbackService: mockService as unknown as FeedbackService,
        authConfig: devConfig,
      }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  it("allows GET /api/feedback without auth in dev mode", async () => {
    const res = await app.inject({ method: "GET", url: "/api/feedback" })
    expect(res.statusCode).toBe(200)
  })

  it("allows POST /api/feedback without auth in dev mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { source: "agent", category: "error", severity: "medium", summary: "test" },
    })
    expect(res.statusCode).toBe(201)
  })
})
