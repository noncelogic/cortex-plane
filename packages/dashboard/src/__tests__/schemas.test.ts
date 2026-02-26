import { describe, expect, it } from "vitest"

import {
  AgentDetailSchema,
  AgentListResponseSchema,
  AgentSummarySchema,
} from "@/lib/schemas/agents"
import { ApprovalListResponseSchema, ApprovalRequestSchema } from "@/lib/schemas/approvals"
import { BrowserEventSchema, BrowserSessionSchema, ScreenshotSchema } from "@/lib/schemas/browser"
import { PaginationSchema } from "@/lib/schemas/common"
import { ContentListResponseSchema, ContentPieceSchema } from "@/lib/schemas/content"
import { JobDetailSchema, JobListResponseSchema, JobSummarySchema } from "@/lib/schemas/jobs"
import { MemoryRecordSchema, MemorySearchResponseSchema } from "@/lib/schemas/memory"

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

describe("PaginationSchema", () => {
  it("accepts valid pagination", () => {
    const data = { total: 42, limit: 20, offset: 0, hasMore: true }
    expect(PaginationSchema.parse(data)).toEqual(data)
  })

  it("rejects missing fields", () => {
    expect(() => PaginationSchema.parse({ total: 1 })).toThrow()
  })

  it("rejects wrong types", () => {
    expect(() =>
      PaginationSchema.parse({ total: "1", limit: 20, offset: 0, hasMore: false }),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe("AgentSummarySchema", () => {
  const validAgent = {
    id: "agt-001",
    name: "Test Agent",
    slug: "test-agent",
    role: "tester",
    status: "ACTIVE",
    lifecycleState: "READY",
    createdAt: "2026-01-01T00:00:00Z",
  }

  it("accepts valid agent summary", () => {
    expect(AgentSummarySchema.parse(validAgent)).toEqual(validAgent)
  })

  it("accepts optional fields", () => {
    const withOptional = {
      ...validAgent,
      description: "A test agent",
      currentJobId: "job-1",
      updatedAt: "2026-01-02T00:00:00Z",
    }
    expect(AgentSummarySchema.parse(withOptional)).toEqual(withOptional)
  })

  it("rejects invalid status", () => {
    expect(() => AgentSummarySchema.parse({ ...validAgent, status: "INVALID" })).toThrow()
  })

  it("rejects invalid lifecycleState", () => {
    expect(() => AgentSummarySchema.parse({ ...validAgent, lifecycleState: "RUNNING" })).toThrow()
  })

  it("rejects missing required fields", () => {
    expect(() => AgentSummarySchema.parse({ id: "a1" })).toThrow()
  })
})

describe("AgentDetailSchema", () => {
  const validAgent = {
    id: "agt-001",
    name: "Test Agent",
    slug: "test-agent",
    role: "tester",
    status: "ACTIVE",
    lifecycleState: "READY",
    createdAt: "2026-01-01T00:00:00Z",
  }

  it("accepts detail with checkpoint", () => {
    const detail = {
      ...validAgent,
      checkpoint: { jobId: "job-1", savedAt: "2026-01-01T00:00:00Z", crc32: 12345 },
    }
    expect(AgentDetailSchema.parse(detail)).toEqual(detail)
  })

  it("accepts config maps", () => {
    const detail = {
      ...validAgent,
      modelConfig: { temperature: 0.7 },
      skillConfig: { tools: ["web"] },
    }
    expect(AgentDetailSchema.parse(detail)).toEqual(detail)
  })
})

describe("AgentListResponseSchema", () => {
  it("accepts valid list response", () => {
    const data = {
      agents: [
        {
          id: "a1",
          name: "Agent",
          slug: "a",
          role: "r",
          status: "ACTIVE",
          lifecycleState: "READY",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
    }
    expect(AgentListResponseSchema.parse(data).agents).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe("JobSummarySchema", () => {
  const validJob = {
    id: "job-001",
    agentId: "agt-001",
    status: "RUNNING",
    type: "inference",
    createdAt: "2026-01-01T00:00:00Z",
  }

  it("accepts valid job summary", () => {
    expect(JobSummarySchema.parse(validJob)).toEqual(validJob)
  })

  it("accepts all job statuses", () => {
    const statuses = [
      "PENDING",
      "SCHEDULED",
      "RUNNING",
      "WAITING_FOR_APPROVAL",
      "COMPLETED",
      "FAILED",
      "TIMED_OUT",
      "RETRYING",
      "DEAD_LETTER",
    ]
    for (const status of statuses) {
      expect(JobSummarySchema.parse({ ...validJob, status }).status).toBe(status)
    }
  })

  it("rejects invalid status", () => {
    expect(() => JobSummarySchema.parse({ ...validJob, status: "UNKNOWN" })).toThrow()
  })
})

describe("JobDetailSchema", () => {
  it("accepts valid job detail with steps and logs", () => {
    const detail = {
      id: "job-001",
      agentId: "agt-001",
      status: "COMPLETED",
      type: "inference",
      createdAt: "2026-01-01T00:00:00Z",
      steps: [{ name: "init", status: "COMPLETED", durationMs: 100 }],
      logs: [{ timestamp: "2026-01-01T00:00:01Z", level: "INFO", message: "Started" }],
      metrics: {
        cpuPercent: 50,
        memoryMb: 256,
        networkInBytes: 1024,
        networkOutBytes: 512,
        threadCount: 4,
      },
    }
    expect(JobDetailSchema.parse(detail).steps).toHaveLength(1)
  })
})

describe("JobListResponseSchema", () => {
  it("accepts empty jobs list", () => {
    const data = {
      jobs: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    }
    expect(JobListResponseSchema.parse(data).jobs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

describe("ApprovalRequestSchema", () => {
  const validApproval = {
    id: "apr-001",
    jobId: "job-001",
    status: "PENDING",
    actionType: "deploy",
    actionSummary: "Deploy to production",
    requestedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-01T01:00:00Z",
  }

  it("accepts valid approval", () => {
    expect(ApprovalRequestSchema.parse(validApproval).status).toBe("PENDING")
  })

  it("accepts all statuses", () => {
    for (const status of ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]) {
      expect(ApprovalRequestSchema.parse({ ...validApproval, status }).status).toBe(status)
    }
  })

  it("rejects invalid status", () => {
    expect(() => ApprovalRequestSchema.parse({ ...validApproval, status: "CANCELLED" })).toThrow()
  })
})

describe("ApprovalListResponseSchema", () => {
  it("accepts valid response", () => {
    const data = {
      approvals: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    }
    expect(ApprovalListResponseSchema.parse(data).approvals).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

describe("MemoryRecordSchema", () => {
  const validRecord = {
    id: "mem-001",
    type: "fact",
    content: "Test content",
    tags: ["test"],
    people: [],
    projects: ["proj-1"],
    importance: 3 as const,
    confidence: 0.9,
    source: "test",
    createdAt: 1700000000000,
    accessCount: 5,
    lastAccessedAt: 1700000100000,
  }

  it("accepts valid memory record", () => {
    expect(MemoryRecordSchema.parse(validRecord).type).toBe("fact")
  })

  it("accepts all memory types", () => {
    for (const type of ["fact", "preference", "event", "system_rule"]) {
      expect(MemoryRecordSchema.parse({ ...validRecord, type }).type).toBe(type)
    }
  })

  it("accepts importance levels 1-5", () => {
    for (const importance of [1, 2, 3, 4, 5]) {
      expect(MemoryRecordSchema.parse({ ...validRecord, importance }).importance).toBe(importance)
    }
  })

  it("rejects invalid importance", () => {
    expect(() => MemoryRecordSchema.parse({ ...validRecord, importance: 6 })).toThrow()
  })

  it("accepts optional score", () => {
    expect(MemoryRecordSchema.parse({ ...validRecord, score: 0.95 }).score).toBe(0.95)
  })
})

describe("MemorySearchResponseSchema", () => {
  it("accepts valid response", () => {
    const data = { results: [] }
    expect(MemorySearchResponseSchema.parse(data).results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

describe("ContentPieceSchema", () => {
  const validPiece = {
    id: "content-001",
    title: "Test Title",
    body: "Test body",
    type: "blog",
    status: "DRAFT",
    agentId: "agt-001",
    agentName: "TestBot",
    wordCount: 100,
    createdAt: "2026-01-01T00:00:00Z",
  }

  it("accepts valid content piece", () => {
    expect(ContentPieceSchema.parse(validPiece).status).toBe("DRAFT")
  })

  it("accepts all content types", () => {
    for (const type of ["blog", "social", "newsletter", "report"]) {
      expect(ContentPieceSchema.parse({ ...validPiece, type }).type).toBe(type)
    }
  })

  it("accepts all content statuses", () => {
    for (const status of ["DRAFT", "IN_REVIEW", "QUEUED", "PUBLISHED"]) {
      expect(ContentPieceSchema.parse({ ...validPiece, status }).status).toBe(status)
    }
  })

  it("rejects invalid type", () => {
    expect(() => ContentPieceSchema.parse({ ...validPiece, type: "video" })).toThrow()
  })
})

describe("ContentListResponseSchema", () => {
  it("accepts valid response", () => {
    const data = {
      content: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    }
    expect(ContentListResponseSchema.parse(data).content).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

describe("BrowserSessionSchema", () => {
  it("accepts valid session", () => {
    const session = {
      id: "bsess-001",
      agentId: "agt-001",
      vncUrl: null,
      status: "connected",
      tabs: [{ id: "tab-1", title: "Google", url: "https://google.com", active: true }],
      latencyMs: 42,
    }
    expect(BrowserSessionSchema.parse(session).status).toBe("connected")
  })

  it("accepts vncUrl as string", () => {
    const session = {
      id: "bsess-001",
      agentId: "agt-001",
      vncUrl: "wss://vnc.example.com/session/123",
      status: "connected",
      tabs: [],
      latencyMs: 30,
    }
    expect(BrowserSessionSchema.parse(session).vncUrl).toBe("wss://vnc.example.com/session/123")
  })

  it("rejects invalid status", () => {
    expect(() =>
      BrowserSessionSchema.parse({
        id: "b1",
        agentId: "a1",
        vncUrl: null,
        status: "ACTIVE",
        tabs: [],
        latencyMs: 0,
      }),
    ).toThrow()
  })
})

describe("BrowserEventSchema", () => {
  it("accepts all event types", () => {
    for (const type of ["GET", "CLICK", "CONSOLE", "SNAPSHOT", "NAVIGATE", "ERROR"]) {
      expect(
        BrowserEventSchema.parse({
          id: "evt-1",
          type,
          timestamp: "2026-01-01T00:00:00Z",
        }).type,
      ).toBe(type)
    }
  })

  it("accepts optional fields", () => {
    const event = {
      id: "evt-1",
      type: "CLICK",
      timestamp: "2026-01-01T00:00:00Z",
      selector: "button.submit",
      message: "Clicked submit",
      durationMs: 150,
      severity: "info",
    }
    expect(BrowserEventSchema.parse(event).selector).toBe("button.submit")
  })
})

describe("ScreenshotSchema", () => {
  it("accepts valid screenshot", () => {
    const ss = {
      id: "ss-001",
      agentId: "agt-001",
      timestamp: "2026-01-01T00:00:00Z",
      thumbnailUrl: "https://example.com/thumb.png",
      fullUrl: "https://example.com/full.png",
      dimensions: { width: 1920, height: 1080 },
    }
    expect(ScreenshotSchema.parse(ss).dimensions.width).toBe(1920)
  })

  it("rejects missing dimensions", () => {
    expect(() =>
      ScreenshotSchema.parse({
        id: "ss-1",
        agentId: "a1",
        timestamp: "t",
        thumbnailUrl: "u",
        fullUrl: "u",
      }),
    ).toThrow()
  })
})
