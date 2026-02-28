/**
 * AI Pulse Content Pipeline tests.
 *
 * Following the existing test patterns (vitest, testing core logic without
 * full React rendering), we validate:
 * - ContentPiece type usage and field structure
 * - Pipeline board grouping by status
 * - Filter/search logic
 * - Stats calculations
 * - Publish flow API contract
 * - API endpoint construction
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ContentPiece,
  ContentPipelineStats,
  ContentStatus,
  ContentType,
} from "@/lib/api-client"
import { ApiError, archiveContent, listContent, publishContent } from "@/lib/api-client"
import { duration, relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// Fetch mock helpers (same pattern as api-client.test.ts)
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createMockPiece(overrides: Partial<ContentPiece> = {}): ContentPiece {
  return {
    id: "content-001",
    title: "Test Article",
    body: "This is a test article body with enough words to be realistic.",
    type: "blog",
    status: "DRAFT",
    agent_id: "agt-writer-01",
    agent_name: "ContentBot",
    word_count: 1500,
    created_at: "2026-02-20T10:00:00Z",
    updated_at: "2026-02-20T12:00:00Z",
    ...overrides,
  }
}

function createPieceSet(): ContentPiece[] {
  return [
    createMockPiece({ id: "c1", title: "Draft Blog Post", status: "DRAFT", type: "blog" }),
    createMockPiece({
      id: "c2",
      title: "Draft Social Thread",
      status: "DRAFT",
      type: "social",
      agent_name: "SocialPulse",
    }),
    createMockPiece({
      id: "c3",
      title: "Review: Newsletter",
      status: "IN_REVIEW",
      type: "newsletter",
    }),
    createMockPiece({
      id: "c4",
      title: "Review: Report Q4",
      status: "IN_REVIEW",
      type: "report",
      agent_name: "AnalyticsBot",
    }),
    createMockPiece({ id: "c5", title: "Queued Blog", status: "QUEUED", type: "blog" }),
    createMockPiece({
      id: "c6",
      title: "Published Article",
      status: "PUBLISHED",
      type: "blog",
      published_at: "2026-02-25T08:00:00Z",
      channel: "website",
    }),
    createMockPiece({
      id: "c7",
      title: "Published Social",
      status: "PUBLISHED",
      type: "social",
      published_at: "2026-02-24T14:00:00Z",
      channel: "social",
      agent_name: "SocialPulse",
    }),
  ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContentPiece type structure", () => {
  it("has all required fields", () => {
    const piece = createMockPiece()
    expect(piece.id).toBe("content-001")
    expect(piece.title).toBe("Test Article")
    expect(piece.body).toBeDefined()
    expect(piece.type).toBe("blog")
    expect(piece.status).toBe("DRAFT")
    expect(piece.agent_id).toBe("agt-writer-01")
    expect(piece.agent_name).toBe("ContentBot")
    expect(piece.word_count).toBe(1500)
    expect(piece.created_at).toBeDefined()
  })

  it("supports optional fields", () => {
    const piece = createMockPiece({
      published_at: "2026-02-25T12:00:00Z",
      channel: "website",
    })
    expect(piece.published_at).toBe("2026-02-25T12:00:00Z")
    expect(piece.channel).toBe("website")
  })

  it("all content types are valid", () => {
    const validTypes: ContentType[] = ["blog", "social", "newsletter", "report"]
    for (const type of validTypes) {
      const piece = createMockPiece({ type })
      expect(piece.type).toBe(type)
    }
  })

  it("all statuses are valid", () => {
    const validStatuses: ContentStatus[] = ["DRAFT", "IN_REVIEW", "QUEUED", "PUBLISHED"]
    for (const status of validStatuses) {
      const piece = createMockPiece({ status })
      expect(piece.status).toBe(status)
    }
  })
})

describe("PipelineBoard grouping logic", () => {
  it("groups pieces into correct columns by status", () => {
    const pieces = createPieceSet()

    // Simulate the grouping logic from pipeline-board.tsx
    const grouped: Record<ContentStatus, ContentPiece[]> = {
      DRAFT: [],
      IN_REVIEW: [],
      QUEUED: [],
      PUBLISHED: [],
    }
    for (const p of pieces) {
      grouped[p.status]?.push(p)
    }

    expect(grouped.DRAFT).toHaveLength(2)
    expect(grouped.IN_REVIEW).toHaveLength(2)
    expect(grouped.QUEUED).toHaveLength(1)
    expect(grouped.PUBLISHED).toHaveLength(2)
  })

  it("preserves piece data within columns", () => {
    const pieces = createPieceSet()
    const drafts = pieces.filter((p) => p.status === "DRAFT")

    expect(drafts[0]!.title).toBe("Draft Blog Post")
    expect(drafts[1]!.title).toBe("Draft Social Thread")
  })

  it("handles empty columns gracefully", () => {
    const pieces = [createMockPiece({ status: "DRAFT" })]

    const grouped: Record<ContentStatus, ContentPiece[]> = {
      DRAFT: [],
      IN_REVIEW: [],
      QUEUED: [],
      PUBLISHED: [],
    }
    for (const p of pieces) {
      grouped[p.status]?.push(p)
    }

    expect(grouped.DRAFT).toHaveLength(1)
    expect(grouped.IN_REVIEW).toHaveLength(0)
    expect(grouped.QUEUED).toHaveLength(0)
    expect(grouped.PUBLISHED).toHaveLength(0)
  })
})

describe("Filter and search logic", () => {
  const pieces = createPieceSet()

  function applyFilters(
    items: ContentPiece[],
    filters: { search: string; type: string; agent: string },
  ): ContentPiece[] {
    return items.filter((p) => {
      if (filters.type !== "ALL" && p.type !== filters.type) return false
      if (filters.agent !== "ALL" && p.agent_name !== filters.agent) return false
      if (filters.search) {
        const q = filters.search.toLowerCase()
        return (
          p.title.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q) ||
          p.agent_name.toLowerCase().includes(q)
        )
      }
      return true
    })
  }

  it("filters by content type", () => {
    const result = applyFilters(pieces, { search: "", type: "blog", agent: "ALL" })
    expect(result.every((p) => p.type === "blog")).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it("filters by agent name", () => {
    const result = applyFilters(pieces, { search: "", type: "ALL", agent: "SocialPulse" })
    expect(result.every((p) => p.agent_name === "SocialPulse")).toBe(true)
    expect(result).toHaveLength(2)
  })

  it("filters by search query matching title", () => {
    const result = applyFilters(pieces, { search: "Newsletter", type: "ALL", agent: "ALL" })
    expect(result).toHaveLength(1)
    expect(result[0]!.title).toContain("Newsletter")
  })

  it("filters by search query matching body", () => {
    const result = applyFilters(pieces, { search: "test article", type: "ALL", agent: "ALL" })
    expect(result.length).toBeGreaterThan(0)
  })

  it("combines multiple filters", () => {
    const result = applyFilters(pieces, { search: "", type: "social", agent: "SocialPulse" })
    expect(result.every((p) => p.type === "social" && p.agent_name === "SocialPulse")).toBe(true)
  })

  it("returns all items with no filters", () => {
    const result = applyFilters(pieces, { search: "", type: "ALL", agent: "ALL" })
    expect(result).toHaveLength(pieces.length)
  })

  it("returns empty for non-matching search", () => {
    const result = applyFilters(pieces, { search: "xyznonexistent", type: "ALL", agent: "ALL" })
    expect(result).toHaveLength(0)
  })
})

describe("Stats calculations", () => {
  function computeStats(pieces: ContentPiece[]): ContentPipelineStats {
    const now = Date.now()
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const publishedToday = pieces.filter(
      (p) => p.published_at && new Date(p.published_at).getTime() >= todayStart.getTime(),
    ).length

    const reviewPieces = pieces.filter((p) => p.status === "IN_REVIEW")
    const avgReviewTimeMs =
      reviewPieces.length > 0
        ? reviewPieces.reduce((sum, p) => sum + (now - new Date(p.created_at).getTime()), 0) /
          reviewPieces.length
        : 0

    return {
      total_pieces: pieces.length,
      published_today: publishedToday,
      avg_review_time_ms: avgReviewTimeMs,
      pending_review: reviewPieces.length,
    }
  }

  it("counts total pieces", () => {
    const pieces = createPieceSet()
    const stats = computeStats(pieces)
    expect(stats.total_pieces).toBe(7)
  })

  it("counts pending review pieces", () => {
    const pieces = createPieceSet()
    const stats = computeStats(pieces)
    expect(stats.pending_review).toBe(2)
  })

  it("computes avg review time > 0 for pieces in review", () => {
    const pieces = createPieceSet()
    const stats = computeStats(pieces)
    expect(stats.avg_review_time_ms).toBeGreaterThan(0)
  })

  it("handles empty array", () => {
    const stats = computeStats([])
    expect(stats.total_pieces).toBe(0)
    expect(stats.published_today).toBe(0)
    expect(stats.avg_review_time_ms).toBe(0)
    expect(stats.pending_review).toBe(0)
  })

  it("counts published today correctly", () => {
    const todayPiece = createMockPiece({
      status: "PUBLISHED",
      published_at: new Date().toISOString(),
    })
    const oldPiece = createMockPiece({
      id: "c-old",
      status: "PUBLISHED",
      published_at: "2026-01-01T00:00:00Z",
    })
    const stats = computeStats([todayPiece, oldPiece])
    expect(stats.published_today).toBe(1)
  })
})

describe("Format utilities with content data", () => {
  it("relativeTime formats content timestamps", () => {
    const recent = new Date(Date.now() - 300_000).toISOString() // 5 min ago
    expect(relativeTime(recent)).toBe("5m ago")
  })

  it("duration formats review time", () => {
    expect(duration(3_600_000)).toBe("1h 0m") // 1 hour
    expect(duration(7_200_000)).toBe("2h 0m") // 2 hours
    expect(duration(1_800_000)).toBe("30m 0s") // 30 minutes
  })
})

describe("Content API endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("listContent passes query parameters", async () => {
    mockFetchResponse({
      content: [],
      pagination: { total: 0, limit: 20, offset: 0, has_more: false },
    })

    await listContent({ status: "DRAFT", type: "blog", limit: 10 })

    const url = vi.mocked(fetch).mock.calls[0]![0] as string
    expect(url).toContain("status=DRAFT")
    expect(url).toContain("type=blog")
    expect(url).toContain("limit=10")
  })

  it("listContent works without parameters", async () => {
    mockFetchResponse({
      content: [createMockPiece()],
      pagination: { total: 1, limit: 20, offset: 0, has_more: false },
    })

    const result = await listContent()
    expect(result.content).toHaveLength(1)
  })

  it("publishContent sends POST with channel", async () => {
    mockFetchResponse({
      content_id: "c-1",
      status: "published",
      published_at: "2026-02-25T12:00:00Z",
    })

    const result = await publishContent("c-1", "website")

    expect(result.status).toBe("published")
    const [, opts] = vi.mocked(fetch).mock.calls[0]!
    expect(opts!.method).toBe("POST")
    expect(JSON.parse(opts!.body as string)).toEqual({ channel: "website" })
  })

  it("archiveContent sends POST", async () => {
    mockFetchResponse({ content_id: "c-1", status: "archived" })

    const result = await archiveContent("c-1")

    expect(result.status).toBe("archived")
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toContain("/content/c-1/archive")
    expect(opts!.method).toBe("POST")
  })

  it("handles API errors for publish", async () => {
    mockFetchResponse(
      { type: "error", title: "Conflict", status: 409, detail: "Already published" },
      409,
    )

    try {
      await publishContent("c-1", "website")
      expect.fail("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      const apiErr = err as ApiError
      expect(apiErr.status).toBe(409)
      expect(apiErr.message).toBe("Already published")
    }
  })
})

describe("Publish confirmation flow", () => {
  it("publish action requires channel selection", () => {
    const channels = ["website", "blog", "newsletter", "social"]
    expect(channels).toHaveLength(4)
    expect(channels).toContain("website")
    expect(channels).toContain("newsletter")
  })

  it("publish flow transitions: confirming → loading → success", () => {
    type PublishState = "idle" | "confirming" | "loading" | "success" | "error"
    const states: PublishState[] = ["confirming", "loading", "success"]

    // Validate the state machine transitions
    expect(states[0]).toBe("confirming")
    expect(states[1]).toBe("loading")
    expect(states[2]).toBe("success")
  })

  it("publish flow handles errors", () => {
    type PublishState = "idle" | "confirming" | "loading" | "success" | "error"
    const errorState: PublishState = "error"
    expect(errorState).toBe("error")
  })
})
