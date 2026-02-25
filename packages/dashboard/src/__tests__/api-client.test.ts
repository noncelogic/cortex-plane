import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  approveRequest,
  getAgent,
  listAgents,
  listJobs,
  type ProblemDetail,
  searchMemory,
  steerAgent,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: statusForCode(status),
      json: () => Promise.resolve(body),
    }),
  )
}

function mockFetchNetworkError(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
}

function statusForCode(code: number): string {
  const map: Record<number, string> = {
    200: "OK",
    202: "Accepted",
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
  }
  return map[code] ?? "Unknown"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// API_BASE is evaluated at module load time, defaulting to localhost:4000
const API_BASE = "http://localhost:4000"

describe("API Client", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("successful requests", () => {
    it("listAgents returns agents and pagination", async () => {
      const body = {
        agents: [{ id: "a1", name: "Agent 1", slug: "a1", role: "test" }],
        pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
      }
      mockFetchResponse(body)

      const result = await listAgents({ status: "ACTIVE", limit: 10 })

      expect(result.agents).toHaveLength(1)
      expect(result.pagination.total).toBe(1)

      const fetchCall = vi.mocked(fetch).mock.calls[0]!
      expect(fetchCall[0]).toContain("status=ACTIVE")
      expect(fetchCall[0]).toContain("limit=10")
    })

    it("getAgent fetches by ID", async () => {
      mockFetchResponse({ id: "agent-1", name: "Test Agent" })

      const result = await getAgent("agent-1")

      expect(result.id).toBe("agent-1")
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${API_BASE}/agents/agent-1`)
    })

    it("steerAgent sends POST with body", async () => {
      mockFetchResponse({ steerMessageId: "sm-1", status: "accepted" })

      await steerAgent("agent-1", { message: "focus on tests", priority: "high" })

      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect(opts!.method).toBe("POST")
      expect(JSON.parse(opts!.body as string)).toEqual({
        message: "focus on tests",
        priority: "high",
      })
    })

    it("listJobs passes query parameters", async () => {
      mockFetchResponse({
        jobs: [],
        pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
      })

      await listJobs({ agentId: "a1", status: "RUNNING" })

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toContain("agentId=a1")
      expect(url).toContain("status=RUNNING")
    })

    it("searchMemory passes query and agentId", async () => {
      mockFetchResponse({ results: [] })

      await searchMemory({ agentId: "a1", query: "deployment", limit: 5 })

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toContain("agentId=a1")
      expect(url).toContain("query=deployment")
      expect(url).toContain("limit=5")
    })

    it("approveRequest sends decision", async () => {
      mockFetchResponse({
        approvalRequestId: "apr-1",
        decision: "APPROVED",
        decidedAt: "2026-02-24T14:35:00Z",
      })

      const result = await approveRequest("apr-1", "APPROVED", "joe@test.com", "LGTM")

      expect(result.decision).toBe("APPROVED")
      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect(JSON.parse(opts!.body as string)).toEqual({
        decision: "APPROVED",
        decidedBy: "joe@test.com",
        channel: "dashboard",
        reason: "LGTM",
      })
    })
  })

  describe("API key header", () => {
    it("sends X-API-Key when env is set", async () => {
      vi.stubEnv("NEXT_PUBLIC_CORTEX_API_KEY", "test-key-123")
      mockFetchResponse({ id: "a1" })

      await getAgent("a1")

      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect((opts!.headers as Record<string, string>)["X-API-Key"]).toBe("test-key-123")
    })

    it("omits X-API-Key when env is not set", async () => {
      mockFetchResponse({ id: "a1" })

      await getAgent("a1")

      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect((opts!.headers as Record<string, string>)["X-API-Key"]).toBeUndefined()
    })
  })

  describe("error handling", () => {
    it("throws ApiError with RFC 7807 ProblemDetail", async () => {
      const problem: ProblemDetail = {
        type: "https://cortex-plane.dev/errors/not-found",
        title: "Not Found",
        status: 404,
        detail: "Agent agent-1 is not managed by this control plane.",
        instance: "/agents/agent-1",
      }
      mockFetchResponse(problem, 404)

      try {
        await getAgent("agent-1")
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(404)
        expect(apiErr.message).toBe("Agent agent-1 is not managed by this control plane.")
        expect(apiErr.problem).toBeDefined()
        expect(apiErr.problem!.type).toBe("https://cortex-plane.dev/errors/not-found")
        expect(apiErr.problem!.instance).toBe("/agents/agent-1")
      }
    })

    it("throws ApiError with fallback message for non-RFC-7807 errors", async () => {
      mockFetchResponse({ message: "Something broke" }, 500)

      try {
        await listAgents()
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(500)
        expect(apiErr.message).toBe("Something broke")
        expect(apiErr.problem).toBeUndefined()
      }
    })

    it("throws ApiError with statusText when body is unparseable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          json: () => Promise.reject(new Error("invalid json")),
        }),
      )

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(502)
        expect(apiErr.message).toBe("Bad Gateway")
      }
    })

    it("propagates network errors as-is", async () => {
      mockFetchNetworkError()

      await expect(listAgents()).rejects.toThrow("Failed to fetch")
    })

    it("handles 409 Conflict responses", async () => {
      const problem: ProblemDetail = {
        type: "https://cortex-plane.dev/errors/conflict",
        title: "Conflict",
        status: 409,
        detail: "Cannot steer agent: agent is in READY state, must be EXECUTING.",
      }
      mockFetchResponse(problem, 409)

      try {
        await steerAgent("a1", { message: "test" })
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(409)
        expect(apiErr.message).toContain("READY state")
      }
    })
  })
})
