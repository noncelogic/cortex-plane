import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApprovalService } from "../approval/service.js"
import { hashApiKey } from "../middleware/api-keys.js"
import type { AuthConfig } from "../middleware/types.js"
import { approvalRoutes } from "../routes/approval.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Test keys & auth config
// ---------------------------------------------------------------------------

const OPERATOR_KEY = "sk-operator-test-key"
const APPROVER_KEY = "sk-approver-test-key"
const BOTH_KEY = "sk-both-test-key"
const VIEWER_KEY = "sk-viewer-only-key"

const authConfig: AuthConfig = {
  apiKeys: [
    {
      keyHash: hashApiKey(OPERATOR_KEY),
      userId: "user-operator",
      roles: ["operator"],
      label: "Operator Key",
    },
    {
      keyHash: hashApiKey(APPROVER_KEY),
      userId: "user-approver",
      roles: ["approver"],
      label: "Approver Key",
    },
    {
      keyHash: hashApiKey(BOTH_KEY),
      userId: "user-both",
      roles: ["operator", "approver"],
      label: "Both Key",
    },
    {
      keyHash: hashApiKey(VIEWER_KEY),
      userId: "user-viewer",
      roles: ["viewer"],
      label: "Viewer Key",
    },
  ],
  requireAuth: true,
}

// ---------------------------------------------------------------------------
// Mock ApprovalService
// ---------------------------------------------------------------------------

function createMockApprovalService() {
  return {
    createRequest: vi.fn().mockResolvedValue({
      approvalRequestId: "approval-1",
      plaintextToken: "cortex_apr_1_testtoken",
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
    decide: vi.fn().mockResolvedValue({
      success: true,
      approvalRequestId: "approval-1",
      decision: "APPROVED",
    }),
    decideByToken: vi.fn().mockResolvedValue({
      success: true,
      approvalRequestId: "approval-1",
      decision: "APPROVED",
    }),
    getRequest: vi.fn().mockResolvedValue({
      id: "approval-1",
      requested_by_agent_id: "agent-1",
    }),
    list: vi.fn().mockResolvedValue([]),
    getAuditTrail: vi.fn().mockResolvedValue([]),
    getPendingForJob: vi.fn().mockResolvedValue([]),
    recordNotification: vi.fn().mockResolvedValue(undefined),
    expireStaleRequests: vi.fn().mockResolvedValue(0),
  } as unknown as ApprovalService
}

function createMockSSEManager() {
  return {
    connect: vi.fn().mockReturnValue({ connectionId: "conn-1" }),
    broadcast: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as SSEConnectionManager
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("Approval routes with auth", () => {
  let app: FastifyInstance
  let mockService: ReturnType<typeof createMockApprovalService>
  let mockSSE: ReturnType<typeof createMockSSEManager>

  beforeEach(async () => {
    app = Fastify({ logger: false })
    mockService = createMockApprovalService()
    mockSSE = createMockSSEManager()

    await app.register(
      approvalRoutes({
        approvalService: mockService as unknown as ApprovalService,
        sseManager: mockSSE as unknown as SSEConnectionManager,
        authConfig,
      }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // POST /jobs/:jobId/approval — requires operator
  // -----------------------------------------------------------------------
  describe("POST /jobs/:jobId/approval", () => {
    const jobId = "00000000-0000-0000-0000-000000000001"
    const validBody = {
      agentId: "00000000-0000-0000-0000-000000000002",
      actionType: "deploy_staging",
      actionSummary: "Deploy to staging",
      actionDetail: { image: "app:v2" },
    }

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/approval`,
        payload: validBody,
      })
      expect(res.statusCode).toBe(401)
    })

    it("returns 403 with approver role (needs operator)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/approval`,
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: validBody,
      })
      expect(res.statusCode).toBe(403)
    })

    it("returns 403 with viewer role", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/approval`,
        headers: { authorization: `Bearer ${VIEWER_KEY}` },
        payload: validBody,
      })
      expect(res.statusCode).toBe(403)
    })

    it("returns 201 with operator role", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/approval`,
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: validBody,
      })
      expect(res.statusCode).toBe(201)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(res.json().approvalRequestId).toBe("approval-1")
    })

    it("returns 201 with both roles", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/approval`,
        headers: { authorization: `Bearer ${BOTH_KEY}` },
        payload: validBody,
      })
      expect(res.statusCode).toBe(201)
    })
  })

  // -----------------------------------------------------------------------
  // POST /approval/:id/decide — requires approver
  // -----------------------------------------------------------------------
  describe("POST /approval/:id/decide", () => {
    const approvalId = "00000000-0000-0000-0000-000000000001"

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        payload: { decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(401)
    })

    it("returns 403 with operator role (needs approver)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(403)
    })

    it("returns 200 with approver role", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(res.json().decision).toBe("APPROVED")
    })

    it("derives decidedBy from authenticated principal, not body", async () => {
      await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { decision: "APPROVED" },
      })

      // The service should have been called with the principal's userId
      const decideCall = (mockService.decide as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(decideCall![2]).toBe("user-approver") // decidedBy from auth
    })

    it("does not accept decidedBy from body — field removed from schema", async () => {
      await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { decision: "APPROVED", decidedBy: "spoofed-user" },
      })

      const decideCall = (mockService.decide as ReturnType<typeof vi.fn>).mock.calls[0]
      // decidedBy must come from auth principal, not body
      expect(decideCall![2]).toBe("user-approver")
    })

    it("passes actor metadata to service", async () => {
      await app.inject({
        method: "POST",
        url: `/approval/${approvalId}/decide`,
        headers: {
          authorization: `Bearer ${APPROVER_KEY}`,
          "user-agent": "TestClient/1.0",
        },
        payload: { decision: "REJECTED", reason: "Not ready" },
      })

      const decideCall = (mockService.decide as ReturnType<typeof vi.fn>).mock.calls[0]
      const actorMetadata = decideCall![5] as {
        userId: string
        displayName: string
        authMethod: string
        userAgent: string
      }
      expect(actorMetadata).toBeDefined()
      expect(actorMetadata.userId).toBe("user-approver")
      expect(actorMetadata.displayName).toBe("Approver Key")
      expect(actorMetadata.authMethod).toBe("api_key")
      expect(actorMetadata.userAgent).toBe("TestClient/1.0")
    })
  })

  // -----------------------------------------------------------------------
  // POST /approval/token/decide — requires approver (token-based flow)
  // -----------------------------------------------------------------------
  describe("POST /approval/token/decide", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/approval/token/decide",
        payload: { token: "cortex_apr_1_test", decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(401)
    })

    it("returns 403 with operator role (needs approver)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/approval/token/decide",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
        payload: { token: "cortex_apr_1_test", decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(403)
    })

    it("returns 200 with approver role", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/approval/token/decide",
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { token: "cortex_apr_1_test", decision: "APPROVED" },
      })
      expect(res.statusCode).toBe(200)
    })

    it("derives decidedBy from auth principal", async () => {
      await app.inject({
        method: "POST",
        url: "/approval/token/decide",
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { token: "cortex_apr_1_test", decision: "APPROVED" },
      })

      const call = (mockService.decideByToken as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call![2]).toBe("user-approver")
    })

    it("passes actor metadata for token-based decide", async () => {
      await app.inject({
        method: "POST",
        url: "/approval/token/decide",
        headers: { authorization: `Bearer ${APPROVER_KEY}` },
        payload: { token: "cortex_apr_1_test", decision: "APPROVED" },
      })

      const call = (mockService.decideByToken as ReturnType<typeof vi.fn>).mock.calls[0]
      const actorMetadata = call![5] as { userId: string }
      expect(actorMetadata).toBeDefined()
      expect(actorMetadata.userId).toBe("user-approver")
    })
  })

  // -----------------------------------------------------------------------
  // GET /approvals — requires auth (any role)
  // -----------------------------------------------------------------------
  describe("GET /approvals", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/approvals" })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with any authenticated user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/approvals",
        headers: { authorization: `Bearer ${VIEWER_KEY}` },
      })
      expect(res.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(res.json().approvals).toEqual([])
    })

    it("returns 200 with operator", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/approvals",
        headers: { authorization: `Bearer ${OPERATOR_KEY}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // GET /approvals/:id — requires auth (any role)
  // -----------------------------------------------------------------------
  describe("GET /approvals/:id", () => {
    const id = "00000000-0000-0000-0000-000000000001"

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: `/approvals/${id}` })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/approvals/${id}`,
        headers: { authorization: `Bearer ${VIEWER_KEY}` },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // -----------------------------------------------------------------------
  // GET /approvals/:id/audit — requires auth (any role)
  // -----------------------------------------------------------------------
  describe("GET /approvals/:id/audit", () => {
    const id = "00000000-0000-0000-0000-000000000001"

    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: `/approvals/${id}/audit` })
      expect(res.statusCode).toBe(401)
    })

    it("returns 200 with auth and audit entries", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/approvals/${id}/audit`,
        headers: { authorization: `Bearer ${VIEWER_KEY}` },
      })
      expect(res.statusCode).toBe(200)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(res.json().audit).toEqual([])
    })
  })

  // -----------------------------------------------------------------------
  // GET /approvals/stream — SSE auth validated on connection
  // -----------------------------------------------------------------------
  describe("GET /approvals/stream", () => {
    it("returns 401 without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/approvals/stream" })
      expect(res.statusCode).toBe(401)
    })

    // Note: can't easily test full SSE in inject mode, but we verify auth
    // is checked before the connection is established
  })
})

// ---------------------------------------------------------------------------
// Dev mode: approval routes with no auth configured
// ---------------------------------------------------------------------------

describe("Approval routes in dev mode (no auth)", () => {
  const devConfig: AuthConfig = {
    apiKeys: [],
    requireAuth: false,
  }

  let app: FastifyInstance
  let mockService: ReturnType<typeof createMockApprovalService>

  beforeEach(async () => {
    app = Fastify({ logger: false })
    mockService = createMockApprovalService()

    await app.register(
      approvalRoutes({
        approvalService: mockService as unknown as ApprovalService,
        authConfig: devConfig,
      }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  it("allows create without auth in dev mode", async () => {
    const jobId = "00000000-0000-0000-0000-000000000001"
    const res = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/approval`,
      payload: {
        agentId: "00000000-0000-0000-0000-000000000002",
        actionType: "deploy",
        actionSummary: "Deploy",
        actionDetail: {},
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it("allows decide without auth in dev mode", async () => {
    const id = "00000000-0000-0000-0000-000000000001"
    const res = await app.inject({
      method: "POST",
      url: `/approval/${id}/decide`,
      payload: { decision: "APPROVED" },
    })
    expect(res.statusCode).toBe(200)
  })

  it("uses dev-user as decidedBy in dev mode", async () => {
    const id = "00000000-0000-0000-0000-000000000001"
    await app.inject({
      method: "POST",
      url: `/approval/${id}/decide`,
      payload: { decision: "APPROVED" },
    })

    const decideCall = (mockService.decide as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(decideCall![2]).toBe("dev-user")
  })
})
