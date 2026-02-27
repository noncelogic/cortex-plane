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

function mockFetchSequence(
  ...responses: Array<{ body?: unknown; status?: number; error?: boolean }>
): void {
  const mock = vi.fn()
  for (const [_i, r] of responses.entries()) {
    if (r.error) {
      mock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    } else {
      const status = r.status ?? 200
      mock.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        statusText: statusForCode(status),
        json: () => Promise.resolve(r.body),
      })
    }
  }
  vi.stubGlobal("fetch", mock)
}

function statusForCode(code: number): string {
  const map: Record<number, string> = {
    200: "OK",
    202: "Accepted",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
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
        agents: [
          {
            id: "a1",
            name: "Agent 1",
            slug: "a1",
            role: "test",
            status: "ACTIVE",
            lifecycleState: "READY",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
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

    it("listAgents normalizes {agents, count} response into pagination", async () => {
      // The control-plane currently returns {agents, count} without a
      // full pagination envelope. The schema should accept this and
      // synthesize a pagination object.
      const body = {
        agents: [
          {
            id: "a1",
            name: "Agent 1",
            slug: "a1",
            role: "test",
            status: "ACTIVE",
            lifecycleState: "READY",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        count: 1,
      }
      mockFetchResponse(body)

      const result = await listAgents()

      expect(result.agents).toHaveLength(1)
      expect(result.pagination).toBeDefined()
      expect(result.pagination.total).toBe(1)
      expect(result.pagination.hasMore).toBe(false)
    })

    it("listAgents handles empty {agents:[], count:0} response", async () => {
      mockFetchResponse({ agents: [], count: 0 })

      const result = await listAgents()

      expect(result.agents).toEqual([])
      expect(result.pagination.total).toBe(0)
      expect(result.pagination.hasMore).toBe(false)
    })

    it("getAgent fetches by ID", async () => {
      mockFetchResponse({
        id: "agent-1",
        name: "Test Agent",
        slug: "test-agent",
        role: "tester",
        status: "ACTIVE",
        lifecycleState: "READY",
        createdAt: "2026-01-01T00:00:00Z",
      })

      const result = await getAgent("agent-1")

      expect(result.id).toBe("agent-1")
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${API_BASE}/agents/agent-1`)
    })

    it("steerAgent sends POST with body", async () => {
      mockFetchResponse({
        steerMessageId: "sm-1",
        status: "accepted",
        agentId: "agent-1",
        priority: "high",
      })

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
      mockFetchResponse({
        id: "a1",
        name: "A1",
        slug: "a1",
        role: "test",
        status: "ACTIVE",
        lifecycleState: "READY",
        createdAt: "2026-01-01T00:00:00Z",
      })

      await getAgent("a1")

      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect((opts!.headers as Record<string, string>)["X-API-Key"]).toBe("test-key-123")
    })

    it("omits X-API-Key when env is not set", async () => {
      mockFetchResponse({
        id: "a1",
        name: "A1",
        slug: "a1",
        role: "test",
        status: "ACTIVE",
        lifecycleState: "READY",
        createdAt: "2026-01-01T00:00:00Z",
      })

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
      // 502 is retryable, so mock 3 attempts (initial + 2 retries)
      const mockRes = {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: () => Promise.reject(new Error("invalid json")),
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockRes))

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

    it("wraps network errors as ApiError with CONNECTION_REFUSED code", async () => {
      mockFetchNetworkError()

      try {
        await listAgents()
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(0)
        expect(apiErr.code).toBe("CONNECTION_REFUSED")
        expect(apiErr.isConnectionError).toBe(true)
      }
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

  describe("error classification", () => {
    it("classifies 401 as AUTH_ERROR", async () => {
      mockFetchResponse({ message: "Unauthorized" }, 401)

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("AUTH_ERROR")
        expect(apiErr.isAuth).toBe(true)
      }
    })

    it("classifies 403 as AUTH_ERROR", async () => {
      mockFetchResponse({ message: "Forbidden" }, 403)

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("AUTH_ERROR")
        expect(apiErr.isAuth).toBe(true)
      }
    })

    it("classifies 404 as NOT_FOUND", async () => {
      mockFetchResponse({ message: "Not Found" }, 404)

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("NOT_FOUND")
      }
    })

    it("classifies 500 as SERVER_ERROR", async () => {
      mockFetchResponse({ message: "Internal error" }, 500)

      try {
        await listAgents()
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("SERVER_ERROR")
      }
    })

    it("classifies schema validation failure as SCHEMA_MISMATCH, not CONNECTION_REFUSED", async () => {
      // Simulate the server returning a completely unexpected shape that
      // fails Zod validation (e.g. missing both pagination and count,
      // with wrong agents structure).
      mockFetchResponse({ unexpected: "shape" })

      try {
        await listAgents()
        expect.fail("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("SCHEMA_MISMATCH")
        expect(apiErr.code).not.toBe("CONNECTION_REFUSED")
        expect(apiErr.isConnectionError).toBe(false)
        expect(apiErr.message).toContain("Unexpected response format")
      }
    })
  })

  describe("retry logic", () => {
    it("retries on 503 and succeeds on second attempt", async () => {
      mockFetchSequence(
        { body: { message: "Unavailable" }, status: 503 },
        {
          body: { agents: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } },
          status: 200,
        },
      )

      const result = await listAgents()

      expect(result.agents).toEqual([])
      expect(vi.mocked(fetch).mock.calls).toHaveLength(2)
    })

    it("retries on network errors and succeeds", async () => {
      mockFetchSequence(
        { error: true },
        {
          body: { agents: [], pagination: { total: 0, limit: 20, offset: 0, hasMore: false } },
          status: 200,
        },
      )

      const result = await listAgents()

      expect(result.agents).toEqual([])
      expect(vi.mocked(fetch).mock.calls).toHaveLength(2)
    })

    it("does not retry on 401", async () => {
      mockFetchResponse({ message: "Unauthorized" }, 401)

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("AUTH_ERROR")
      }

      // Only one call — no retries
      expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
    })

    it("does not retry on 404", async () => {
      mockFetchResponse({ message: "Not found" }, 404)

      try {
        await getAgent("a1")
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.code).toBe("NOT_FOUND")
      }

      expect(vi.mocked(fetch).mock.calls).toHaveLength(1)
    })

    it("exhausts retries on persistent 503 and throws TRANSIENT", async () => {
      mockFetchSequence(
        { body: { message: "Unavailable" }, status: 503 },
        { body: { message: "Unavailable" }, status: 503 },
        { body: { message: "Unavailable" }, status: 503 },
      )

      try {
        await listAgents()
        expect.fail("should have thrown")
      } catch (err) {
        const apiErr = err as ApiError
        expect(apiErr.status).toBe(503)
        expect(apiErr.code).toBe("TRANSIENT")
        expect(apiErr.isTransient).toBe(true)
      }

      // Initial + 2 retries = 3 calls
      expect(vi.mocked(fetch).mock.calls).toHaveLength(3)
    })
  })
})
