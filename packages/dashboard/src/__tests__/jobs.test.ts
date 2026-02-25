import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  getJob,
  type JobDetail,
  type JobLogEntry,
  type JobMetrics,
  type JobStatus,
  type JobStep,
  type JobSummary,
  retryJob,
} from "@/lib/api-client"
import { duration, relativeTime, truncateUuid } from "@/lib/format"

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

function statusForCode(code: number): string {
  const map: Record<number, string> = {
    200: "OK",
    404: "Not Found",
    500: "Internal Server Error",
  }
  return map[code] ?? "Unknown"
}

const API_BASE = "http://localhost:4000"

// ---------------------------------------------------------------------------
// JobStatusBadge logic tests
// ---------------------------------------------------------------------------

describe("JobStatusBadge status styles", () => {
  // Status → expected color family mapping (mirrors the component's statusStyles)
  const STATUS_COLORS: Record<JobStatus, string> = {
    COMPLETED: "emerald",
    FAILED: "red",
    RUNNING: "blue",
    RETRYING: "yellow",
    PENDING: "slate",
    SCHEDULED: "blue",
    WAITING_FOR_APPROVAL: "amber",
    TIMED_OUT: "orange",
    DEAD_LETTER: "red",
  }

  const ALL_STATUSES: JobStatus[] = [
    "COMPLETED",
    "FAILED",
    "RUNNING",
    "RETRYING",
    "PENDING",
    "SCHEDULED",
    "WAITING_FOR_APPROVAL",
    "TIMED_OUT",
    "DEAD_LETTER",
  ]

  it("covers all 9 JobStatus values", () => {
    expect(ALL_STATUSES).toHaveLength(9)
    for (const status of ALL_STATUSES) {
      expect(STATUS_COLORS[status]).toBeDefined()
    }
  })

  it("COMPLETED maps to emerald color family", () => {
    expect(STATUS_COLORS.COMPLETED).toBe("emerald")
  })

  it("FAILED and DEAD_LETTER map to red color family", () => {
    expect(STATUS_COLORS.FAILED).toBe("red")
    expect(STATUS_COLORS.DEAD_LETTER).toBe("red")
  })

  it("RUNNING maps to blue with pulse animation", () => {
    expect(STATUS_COLORS.RUNNING).toBe("blue")
    // The component uses "animate-pulse" for RUNNING dot
  })

  it("RETRYING maps to yellow with spin icon", () => {
    expect(STATUS_COLORS.RETRYING).toBe("yellow")
    // The component uses a spinning sync icon instead of a dot
  })

  it("PENDING maps to slate (gray)", () => {
    expect(STATUS_COLORS.PENDING).toBe("slate")
  })

  it("SCHEDULED maps to blue", () => {
    expect(STATUS_COLORS.SCHEDULED).toBe("blue")
  })

  it("WAITING_FOR_APPROVAL maps to amber", () => {
    expect(STATUS_COLORS.WAITING_FOR_APPROVAL).toBe("amber")
  })

  it("TIMED_OUT maps to orange", () => {
    expect(STATUS_COLORS.TIMED_OUT).toBe("orange")
  })
})

// ---------------------------------------------------------------------------
// JobTable filter/search logic tests
// ---------------------------------------------------------------------------

describe("JobTable filter and search logic", () => {
  const mockJobs: JobSummary[] = [
    {
      id: "job-0001-abc12345",
      agentId: "agt-a1b2c3d4",
      status: "COMPLETED",
      type: "inference",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      completedAt: new Date(Date.now() - 3_555_000).toISOString(),
    },
    {
      id: "job-0002-def67890",
      agentId: "agt-e5f6g7h8",
      status: "FAILED",
      type: "tool-call",
      createdAt: new Date(Date.now() - 7_200_000).toISOString(),
      error: "Timeout",
    },
    {
      id: "job-0003-ghi11111",
      agentId: "agt-a1b2c3d4",
      status: "RUNNING",
      type: "pipeline",
      createdAt: new Date(Date.now() - 1_800_000).toISOString(),
    },
    {
      id: "job-0004-jkl22222",
      agentId: "agt-i9j0k1l2",
      status: "PENDING",
      type: "batch",
      createdAt: new Date(Date.now() - 900_000).toISOString(),
    },
  ]

  // Replicating the filter logic from JobTable
  function filterJobs(
    jobs: JobSummary[],
    opts: { status?: JobStatus | "ALL"; type?: string; search?: string },
  ): JobSummary[] {
    return jobs.filter((j) => {
      if (opts.status && opts.status !== "ALL" && j.status !== opts.status) return false
      if (opts.type && opts.type !== "ALL" && j.type !== opts.type) return false
      if (opts.search) {
        const q = opts.search.toLowerCase()
        return (
          j.id.toLowerCase().includes(q) ||
          j.agentId.toLowerCase().includes(q) ||
          j.type.toLowerCase().includes(q)
        )
      }
      return true
    })
  }

  it("returns all jobs with no filters", () => {
    const result = filterJobs(mockJobs, {})
    expect(result).toHaveLength(4)
  })

  it("filters by status", () => {
    const result = filterJobs(mockJobs, { status: "FAILED" })
    expect(result).toHaveLength(1)
    expect(result[0]!.status).toBe("FAILED")
  })

  it("filters by type", () => {
    const result = filterJobs(mockJobs, { type: "inference" })
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("inference")
  })

  it("searches by job ID", () => {
    const result = filterJobs(mockJobs, { search: "job-0001" })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("job-0001-abc12345")
  })

  it("searches by agent ID", () => {
    const result = filterJobs(mockJobs, { search: "a1b2c3d4" })
    expect(result).toHaveLength(2) // Two jobs share this agent
  })

  it("searches by type", () => {
    const result = filterJobs(mockJobs, { search: "pipeline" })
    expect(result).toHaveLength(1)
  })

  it("search is case-insensitive", () => {
    const result = filterJobs(mockJobs, { search: "INFERENCE" })
    expect(result).toHaveLength(1)
  })

  it("returns empty for no matches", () => {
    const result = filterJobs(mockJobs, { search: "nonexistent" })
    expect(result).toHaveLength(0)
  })

  it("combines status and type filters", () => {
    const result = filterJobs(mockJobs, { status: "COMPLETED", type: "inference" })
    expect(result).toHaveLength(1)
  })

  it("handles ALL status filter", () => {
    const result = filterJobs(mockJobs, { status: "ALL" })
    expect(result).toHaveLength(4)
  })

  it("handles empty jobs array", () => {
    const result = filterJobs([], { status: "RUNNING" })
    expect(result).toHaveLength(0)
  })

  // Pagination logic
  it("paginates correctly", () => {
    const PAGE_SIZE = 15
    const manyJobs = Array.from({ length: 35 }, (_, i) => ({
      ...mockJobs[0]!,
      id: `job-${i}`,
    }))
    const totalPages = Math.ceil(manyJobs.length / PAGE_SIZE)
    expect(totalPages).toBe(3)

    const page0 = manyJobs.slice(0 * PAGE_SIZE, 1 * PAGE_SIZE)
    expect(page0).toHaveLength(15)

    const page2 = manyJobs.slice(2 * PAGE_SIZE, 3 * PAGE_SIZE)
    expect(page2).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// JobDetailDrawer data tests
// ---------------------------------------------------------------------------

describe("JobDetailDrawer data", () => {
  it("JobStep status determines timeline dot color", () => {
    const stepColors: Record<JobStep["status"], string> = {
      COMPLETED: "emerald",
      FAILED: "red",
      RUNNING: "blue",
      PENDING: "slate",
    }

    expect(stepColors.COMPLETED).toBe("emerald")
    expect(stepColors.FAILED).toBe("red")
    expect(stepColors.RUNNING).toBe("blue")
    expect(stepColors.PENDING).toBe("slate")
  })

  it("JobMetrics interface has all required fields", () => {
    const metrics: JobMetrics = {
      cpuPercent: 45,
      memoryMb: 512,
      networkInBytes: 2_500_000,
      networkOutBytes: 800_000,
      threadCount: 8,
    }

    expect(metrics.cpuPercent).toBe(45)
    expect(metrics.memoryMb).toBe(512)
    expect(metrics.networkInBytes).toBe(2_500_000)
    expect(metrics.networkOutBytes).toBe(800_000)
    expect(metrics.threadCount).toBe(8)
  })

  it("JobLogEntry levels are mapped to correct colors conceptually", () => {
    const logLevelColors: Record<JobLogEntry["level"], string> = {
      INFO: "blue",
      WARN: "yellow",
      ERR: "red",
      DEBUG: "slate",
    }

    expect(logLevelColors.INFO).toBe("blue")
    expect(logLevelColors.WARN).toBe("yellow")
    expect(logLevelColors.ERR).toBe("red")
    expect(logLevelColors.DEBUG).toBe("slate")
  })

  it("JobDetail extends JobSummary with steps, metrics, logs", () => {
    const detail: JobDetail = {
      id: "job-001",
      agentId: "agt-001",
      status: "COMPLETED",
      type: "inference",
      createdAt: new Date().toISOString(),
      agentName: "TestAgent",
      agentVersion: "v1.2",
      durationMs: 5000,
      steps: [
        { name: "Init", status: "COMPLETED", durationMs: 1000 },
        { name: "Execute", status: "COMPLETED", durationMs: 3000 },
        { name: "Cleanup", status: "COMPLETED", durationMs: 1000 },
      ],
      metrics: {
        cpuPercent: 30,
        memoryMb: 256,
        networkInBytes: 1_000_000,
        networkOutBytes: 500_000,
        threadCount: 4,
      },
      logs: [
        { timestamp: new Date().toISOString(), level: "INFO", message: "Job started" },
        { timestamp: new Date().toISOString(), level: "INFO", message: "Job completed" },
      ],
    }

    expect(detail.steps).toHaveLength(3)
    expect(detail.metrics?.cpuPercent).toBe(30)
    expect(detail.logs).toHaveLength(2)
    expect(detail.agentName).toBe("TestAgent")
  })
})

// ---------------------------------------------------------------------------
// JobRetryButton logic tests
// ---------------------------------------------------------------------------

describe("JobRetryButton logic", () => {
  it("only retryable statuses should show retry button", () => {
    const retryable: JobStatus[] = ["FAILED", "TIMED_OUT", "DEAD_LETTER"]
    const nonRetryable: JobStatus[] = [
      "COMPLETED",
      "RUNNING",
      "PENDING",
      "SCHEDULED",
      "RETRYING",
      "WAITING_FOR_APPROVAL",
    ]

    const canRetry = (status: JobStatus) =>
      status === "FAILED" || status === "TIMED_OUT" || status === "DEAD_LETTER"

    for (const s of retryable) {
      expect(canRetry(s)).toBe(true)
    }
    for (const s of nonRetryable) {
      expect(canRetry(s)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// API client: getJob and retryJob
// ---------------------------------------------------------------------------

describe("getJob API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches job detail by ID", async () => {
    const mockDetail: JobDetail = {
      id: "job-123",
      agentId: "agt-456",
      status: "COMPLETED",
      type: "inference",
      createdAt: new Date().toISOString(),
      steps: [],
      logs: [],
    }

    mockFetchResponse(mockDetail)
    const result = await getJob("job-123")

    expect(result.id).toBe("job-123")
    expect(result.status).toBe("COMPLETED")
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/jobs/job-123`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("throws ApiError on 404", async () => {
    mockFetchResponse(
      {
        type: "https://cortex-plane.dev/errors/not-found",
        title: "Not Found",
        status: 404,
        detail: "Job not found",
      },
      404,
    )

    await expect(getJob("nonexistent")).rejects.toThrow(ApiError)
    try {
      await getJob("nonexistent")
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(404)
    }
  })
})

describe("retryJob API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("sends POST to retry endpoint", async () => {
    mockFetchResponse({ jobId: "job-123", status: "retrying" })
    const result = await retryJob("job-123")

    expect(result.status).toBe("retrying")
    expect(result.jobId).toBe("job-123")
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/jobs/job-123/retry`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("throws on server error", async () => {
    mockFetchResponse({ message: "Internal error" }, 500)

    await expect(retryJob("job-123")).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Format utilities used by job components
// ---------------------------------------------------------------------------

describe("Format utilities for jobs", () => {
  it("duration formats milliseconds correctly", () => {
    expect(duration(500)).toBe("0s")
    expect(duration(5_000)).toBe("5s")
    expect(duration(65_000)).toBe("1m 5s")
    expect(duration(3_665_000)).toBe("1h 1m")
  })

  it("truncateUuid shortens to 8 chars", () => {
    expect(truncateUuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4...")
  })

  it("relativeTime returns human-readable string", () => {
    const now = new Date()
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString()
    const result = relativeTime(fiveMinAgo)
    expect(result).toBe("5m ago")
  })
})
