/**
 * Agent Users — schema contract tests + API client function tests.
 *
 * Validates the agent-user Zod schemas (grants, access requests, pairing codes)
 * and tests the API client wrapper functions for correct URL construction.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createAgentUserGrant,
  generatePairingCode,
  getPendingCounts,
  listAccessRequests,
  listAgentUsers,
  listPairingCodes,
  resolveAccessRequest,
  revokePairingCode,
  revokeUserGrant,
} from "@/lib/api-client"
import {
  AccessRequestListResponseSchema,
  AccessRequestSchema,
  CreateGrantResponseSchema,
  GeneratePairingCodeResponseSchema,
  GrantListResponseSchema,
  PairingCodeListResponseSchema,
  PairingCodeSchema,
  PendingCountResponseSchema,
  UserGrantSchema,
} from "@/lib/schemas/users"

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRANT_FIXTURE = {
  id: "g-001",
  agent_id: "a-001",
  user_account_id: "u-001",
  access_level: "write" as const,
  origin: "dashboard_invite" as const,
  granted_by: "u-admin",
  rate_limit: { max_messages: 60, window_seconds: 3600 },
  token_budget: null,
  expires_at: null,
  revoked_at: null,
  created_at: "2026-03-01T12:00:00.000Z",
}

const ACCESS_REQUEST_FIXTURE = {
  id: "ar-001",
  agent_id: "a-001",
  user_account_id: "u-002",
  channel_mapping_id: "cm-001",
  status: "pending" as const,
  message_preview: "Hello, can I use this agent?",
  reviewed_by: null,
  reviewed_at: null,
  deny_reason: null,
  created_at: "2026-03-05T10:00:00.000Z",
}

const PAIRING_CODE_FIXTURE = {
  id: "pc-001",
  agent_id: "a-001",
  code: "ABCD-1234",
  created_by: "u-admin",
  created_at: "2026-03-06T08:00:00.000Z",
  expires_at: "2026-03-07T08:00:00.000Z",
  redeemed_at: null,
  redeemed_by: null,
  revoked_at: null,
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("Agent-user schema tests", () => {
  describe("UserGrantSchema", () => {
    it("parses a full grant", () => {
      const result = UserGrantSchema.parse(GRANT_FIXTURE)
      expect(result.id).toBe("g-001")
      expect(result.access_level).toBe("write")
      expect(result.origin).toBe("dashboard_invite")
    })

    it("rejects invalid access_level", () => {
      const bad = { ...GRANT_FIXTURE, access_level: "admin" }
      expect(UserGrantSchema.safeParse(bad).success).toBe(false)
    })

    it("rejects invalid origin", () => {
      const bad = { ...GRANT_FIXTURE, origin: "unknown_origin" }
      expect(UserGrantSchema.safeParse(bad).success).toBe(false)
    })

    it("accepts all valid origins", () => {
      for (const origin of [
        "pairing_code",
        "dashboard_invite",
        "auto_team",
        "auto_open",
        "approval",
      ]) {
        const result = UserGrantSchema.safeParse({ ...GRANT_FIXTURE, origin })
        expect(result.success, `origin=${origin}`).toBe(true)
      }
    })
  })

  describe("AccessRequestSchema", () => {
    it("parses a pending request", () => {
      const result = AccessRequestSchema.parse(ACCESS_REQUEST_FIXTURE)
      expect(result.status).toBe("pending")
      expect(result.message_preview).toBe("Hello, can I use this agent?")
    })

    it("parses a denied request", () => {
      const denied = {
        ...ACCESS_REQUEST_FIXTURE,
        status: "denied" as const,
        deny_reason: "Not authorized",
        reviewed_by: "u-admin",
        reviewed_at: "2026-03-05T11:00:00.000Z",
      }
      const result = AccessRequestSchema.parse(denied)
      expect(result.deny_reason).toBe("Not authorized")
    })

    it("rejects invalid status", () => {
      const bad = { ...ACCESS_REQUEST_FIXTURE, status: "expired" }
      expect(AccessRequestSchema.safeParse(bad).success).toBe(false)
    })
  })

  describe("PairingCodeSchema", () => {
    it("parses a code", () => {
      const result = PairingCodeSchema.parse(PAIRING_CODE_FIXTURE)
      expect(result.code).toBe("ABCD-1234")
      expect(result.redeemed_at).toBeNull()
    })

    it("parses a redeemed code", () => {
      const redeemed = {
        ...PAIRING_CODE_FIXTURE,
        redeemed_at: "2026-03-06T09:00:00.000Z",
        redeemed_by: "u-003",
      }
      const result = PairingCodeSchema.parse(redeemed)
      expect(result.redeemed_by).toBe("u-003")
    })
  })

  describe("Response schemas", () => {
    it("GrantListResponseSchema parses grants + total", () => {
      const response = { grants: [GRANT_FIXTURE], total: 1 }
      const result = GrantListResponseSchema.parse(response)
      expect(result.grants).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("GrantListResponseSchema parses empty list", () => {
      const response = { grants: [], total: 0 }
      const result = GrantListResponseSchema.parse(response)
      expect(result.grants).toHaveLength(0)
    })

    it("CreateGrantResponseSchema parses", () => {
      const response = { grant: GRANT_FIXTURE }
      const result = CreateGrantResponseSchema.parse(response)
      expect(result.grant.id).toBe("g-001")
    })

    it("AccessRequestListResponseSchema parses", () => {
      const response = { requests: [ACCESS_REQUEST_FIXTURE], total: 1 }
      const result = AccessRequestListResponseSchema.parse(response)
      expect(result.requests).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("GeneratePairingCodeResponseSchema parses", () => {
      const response = { code: "ABCD-1234", expiresAt: "2026-03-07T08:00:00.000Z" }
      const result = GeneratePairingCodeResponseSchema.parse(response)
      expect(result.code).toBe("ABCD-1234")
    })

    it("PairingCodeListResponseSchema parses", () => {
      const response = { codes: [PAIRING_CODE_FIXTURE] }
      const result = PairingCodeListResponseSchema.parse(response)
      expect(result.codes).toHaveLength(1)
    })

    it("PendingCountResponseSchema parses", () => {
      const response = { counts: { "a-001": 3, "a-002": 0 } }
      const result = PendingCountResponseSchema.parse(response)
      expect(result.counts["a-001"]).toBe(3)
    })
  })
})

// ---------------------------------------------------------------------------
// API client function tests
// ---------------------------------------------------------------------------

describe("Agent-user API client functions", () => {
  describe("listAgentUsers", () => {
    it("calls GET /agents/:agentId/users", async () => {
      mockFetchResponse({ grants: [GRANT_FIXTURE], total: 1 })
      const result = await listAgentUsers("a-001")
      expect(result.grants).toHaveLength(1)

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(url).toContain("/agents/a-001/users")
    })

    it("passes pagination params", async () => {
      mockFetchResponse({ grants: [], total: 0 })
      await listAgentUsers("a-001", { limit: 10, offset: 20 })

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(url).toContain("limit=10")
      expect(url).toContain("offset=20")
    })
  })

  describe("createAgentUserGrant", () => {
    it("calls POST /agents/:agentId/users", async () => {
      mockFetchResponse({ grant: GRANT_FIXTURE }, 200)
      const result = await createAgentUserGrant("a-001", {
        user_account_id: "u-001",
        access_level: "write",
      })
      expect(result.grant.id).toBe("g-001")

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toContain("/agents/a-001/users")
      expect(init.method).toBe("POST")
    })
  })

  describe("generatePairingCode", () => {
    it("calls POST /agents/:agentId/pairing-codes", async () => {
      mockFetchResponse({ code: "ABCD-1234", expiresAt: "2026-03-07T08:00:00.000Z" }, 200)
      const result = await generatePairingCode("a-001")
      expect(result.code).toBe("ABCD-1234")

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toContain("/agents/a-001/pairing-codes")
      expect(init.method).toBe("POST")
    })
  })

  describe("listPairingCodes", () => {
    it("calls GET /agents/:agentId/pairing-codes", async () => {
      mockFetchResponse({ codes: [PAIRING_CODE_FIXTURE] })
      const result = await listPairingCodes("a-001")
      expect(result.codes).toHaveLength(1)
    })
  })

  describe("revokePairingCode", () => {
    it("calls DELETE /agents/:agentId/pairing-codes/:codeId", async () => {
      mockFetchResponse(null, 204)
      await revokePairingCode("a-001", "pc-001")

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toContain("/agents/a-001/pairing-codes/pc-001")
      expect(init.method).toBe("DELETE")
    })
  })

  describe("listAccessRequests", () => {
    it("calls GET /agents/:agentId/access-requests", async () => {
      mockFetchResponse({ requests: [ACCESS_REQUEST_FIXTURE], total: 1 })
      const result = await listAccessRequests("a-001", { status: "pending" })
      expect(result.requests).toHaveLength(1)

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(url).toContain("/agents/a-001/access-requests")
      expect(url).toContain("status=pending")
    })
  })

  describe("resolveAccessRequest", () => {
    it("calls PATCH /agents/:agentId/access-requests/:requestId", async () => {
      mockFetchResponse({ request: { status: "approved", grant_id: "g-new" } })
      await resolveAccessRequest("a-001", "ar-001", { status: "approved" })

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toContain("/agents/a-001/access-requests/ar-001")
      expect(init.method).toBe("PATCH")
    })
  })

  describe("getPendingCounts", () => {
    it("calls GET /access-requests/pending-count", async () => {
      mockFetchResponse({ counts: { "a-001": 5 } })
      const result = await getPendingCounts()
      expect(result.counts["a-001"]).toBe(5)

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
      expect(url).toContain("/access-requests/pending-count")
    })
  })

  describe("revokeUserGrant", () => {
    it("calls DELETE /agents/:agentId/users/:grantId", async () => {
      mockFetchResponse(null, 204)
      await revokeUserGrant("a-001", "g-001")

      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
      expect(url).toContain("/agents/a-001/users/g-001")
      expect(init.method).toBe("DELETE")
    })
  })
})
