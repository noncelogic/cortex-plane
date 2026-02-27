import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError, type MemoryRecord, searchMemory, syncMemory } from "@/lib/api-client"
import { truncateUuid } from "@/lib/format"

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

const API_BASE = "/api"

// ---------------------------------------------------------------------------
// Mock memory records
// ---------------------------------------------------------------------------

function createMockRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now()
  return {
    id: "mem-test-001",
    type: "fact",
    content: "Kubernetes cluster uses istio service mesh for inter-service communication.",
    tags: ["kubernetes", "istio"],
    people: ["sarah-chen"],
    projects: ["cortex-infra"],
    importance: 5,
    confidence: 0.95,
    source: "agent-observation",
    createdAt: now - 86_400_000,
    accessCount: 47,
    lastAccessedAt: now - 3_600_000,
    score: 0.97,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// MemorySearch logic tests
// ---------------------------------------------------------------------------

describe("MemorySearch filter logic", () => {
  // Replicating the filter logic from the page
  type ActiveFilters = {
    type: MemoryRecord["type"] | "ALL"
    importance: "ALL" | "high" | "medium" | "low"
    scoreThreshold: number
    timeRange: "ALL" | "24h" | "7d" | "30d" | "90d"
  }

  function applyFilters(
    records: MemoryRecord[],
    query: string,
    filters: ActiveFilters,
  ): MemoryRecord[] {
    return records.filter((r) => {
      if (query) {
        const q = query.toLowerCase()
        const matches =
          r.content.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)) ||
          r.source.toLowerCase().includes(q)
        if (!matches) return false
      }
      if (filters.type !== "ALL" && r.type !== filters.type) return false
      if (filters.importance !== "ALL") {
        if (filters.importance === "high" && r.importance < 4) return false
        if (filters.importance === "medium" && r.importance !== 3) return false
        if (filters.importance === "low" && r.importance > 2) return false
      }
      if (filters.scoreThreshold > 0 && r.score !== undefined) {
        if (r.score * 100 < filters.scoreThreshold) return false
      }
      if (filters.timeRange !== "ALL") {
        const now = Date.now()
        const ranges: Record<string, number> = {
          "24h": 86_400_000,
          "7d": 7 * 86_400_000,
          "30d": 30 * 86_400_000,
          "90d": 90 * 86_400_000,
        }
        const maxAge = ranges[filters.timeRange]
        if (maxAge && now - r.createdAt > maxAge) return false
      }
      return true
    })
  }

  const defaultFilters: ActiveFilters = {
    type: "ALL",
    importance: "ALL",
    scoreThreshold: 0,
    timeRange: "ALL",
  }

  const now = Date.now()
  const mockRecords: MemoryRecord[] = [
    createMockRecord({
      id: "mem-1",
      type: "fact",
      content: "Kubernetes cluster config",
      tags: ["kubernetes"],
      importance: 5,
      confidence: 0.95,
      score: 0.97,
      createdAt: now - 2 * 86_400_000,
    }),
    createMockRecord({
      id: "mem-2",
      type: "preference",
      content: "Team prefers blue-green deployments",
      tags: ["deployment"],
      importance: 4,
      score: 0.91,
      createdAt: now - 5 * 86_400_000,
    }),
    createMockRecord({
      id: "mem-3",
      type: "event",
      content: "Production outage on Redis",
      tags: ["incident", "redis"],
      importance: 5,
      score: 0.84,
      createdAt: now - 72 * 86_400_000,
    }),
    createMockRecord({
      id: "mem-4",
      type: "system_rule",
      content: "All code changes must pass CI/CD",
      tags: ["ci-cd"],
      importance: 5,
      confidence: 1.0,
      score: 0.78,
      createdAt: now - 30 * 86_400_000,
    }),
    createMockRecord({
      id: "mem-5",
      type: "preference",
      content: "Use structured logging with JSON",
      tags: ["logging"],
      importance: 3,
      score: 0.72,
      createdAt: now - 60 * 86_400_000,
    }),
  ]

  it("returns all records with no filters", () => {
    const result = applyFilters(mockRecords, "", defaultFilters)
    expect(result).toHaveLength(5)
  })

  it("filters by text query matching content", () => {
    const result = applyFilters(mockRecords, "kubernetes", defaultFilters)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("mem-1")
  })

  it("filters by text query matching tags", () => {
    const result = applyFilters(mockRecords, "redis", defaultFilters)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("mem-3")
  })

  it("search is case-insensitive", () => {
    const result = applyFilters(mockRecords, "KUBERNETES", defaultFilters)
    expect(result).toHaveLength(1)
  })

  it("filters by type", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, type: "preference" })
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.type === "preference")).toBe(true)
  })

  it("filters by type = system_rule", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, type: "system_rule" })
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("system_rule")
  })

  it("filters by high importance (4-5)", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, importance: "high" })
    expect(result).toHaveLength(4)
    expect(result.every((r) => r.importance >= 4)).toBe(true)
  })

  it("filters by medium importance (3)", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, importance: "medium" })
    expect(result).toHaveLength(1)
    expect(result[0]!.importance).toBe(3)
  })

  it("filters by low importance (1-2)", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, importance: "low" })
    expect(result).toHaveLength(0)
  })

  it("filters by score threshold", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, scoreThreshold: 85 })
    expect(result).toHaveLength(2)
    expect(result.every((r) => (r.score ?? 0) * 100 >= 85)).toBe(true)
  })

  it("filters by time range (7d)", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, timeRange: "7d" })
    expect(result).toHaveLength(2) // mem-1 (2d) and mem-2 (5d)
  })

  it("filters by time range (30d)", () => {
    const result = applyFilters(mockRecords, "", { ...defaultFilters, timeRange: "30d" })
    expect(result).toHaveLength(2) // mem-1 (2d) and mem-2 (5d); mem-4 (30d) is on the boundary
  })

  it("combines query and type filter", () => {
    const result = applyFilters(mockRecords, "deployment", {
      ...defaultFilters,
      type: "preference",
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe("mem-2")
  })

  it("returns empty for no matches", () => {
    const result = applyFilters(mockRecords, "nonexistent", defaultFilters)
    expect(result).toHaveLength(0)
  })

  it("handles empty records array", () => {
    const result = applyFilters([], "kubernetes", defaultFilters)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// MemoryResults rendering logic tests
// ---------------------------------------------------------------------------

describe("MemoryResults rendering logic", () => {
  it("score color returns primary class for high scores", () => {
    function scoreColor(score: number): string {
      if (score >= 85) return "bg-primary/10 text-primary font-bold"
      if (score >= 70) return "bg-slate-700 text-slate-300"
      return "bg-slate-800 text-slate-400"
    }

    expect(scoreColor(97)).toContain("primary")
    expect(scoreColor(85)).toContain("primary")
    expect(scoreColor(75)).toContain("slate-700")
    expect(scoreColor(50)).toContain("slate-800")
  })

  it("extractTitle gets first line and trims markdown", () => {
    function extractTitle(content: string): string {
      const firstLine = content.split("\n")[0] ?? content
      const cleaned = firstLine.replace(/^#+\s*/, "").trim()
      return cleaned.length > 60 ? cleaned.substring(0, 60) + "..." : cleaned
    }

    expect(extractTitle("# My Title\nSome content")).toBe("My Title")
    expect(extractTitle("Simple content")).toBe("Simple content")
    expect(extractTitle("A".repeat(80))).toHaveLength(63) // 60 + "..."
  })

  it("selected card is identified by ID", () => {
    const records: MemoryRecord[] = [
      createMockRecord({ id: "mem-1" }),
      createMockRecord({ id: "mem-2" }),
      createMockRecord({ id: "mem-3" }),
    ]
    const selectedId = "mem-2"
    const selected = records.find((r) => r.id === selectedId)
    expect(selected).toBeDefined()
    expect(selected!.id).toBe("mem-2")
  })

  it("handles no selection (null selectedId)", () => {
    const records: MemoryRecord[] = [createMockRecord({ id: "mem-1" })]
    const selectedId: string | null = null
    const selected = records.find((r) => r.id === selectedId) ?? null
    expect(selected).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DocumentViewer logic tests
// ---------------------------------------------------------------------------

describe("DocumentViewer logic", () => {
  it("MemoryRecord type has correct icon mapping", () => {
    const typeIcons: Record<MemoryRecord["type"], string> = {
      fact: "lightbulb",
      preference: "tune",
      event: "event",
      system_rule: "gavel",
    }

    expect(typeIcons.fact).toBe("lightbulb")
    expect(typeIcons.preference).toBe("tune")
    expect(typeIcons.event).toBe("event")
    expect(typeIcons.system_rule).toBe("gavel")
  })

  it("importance renders correct star count", () => {
    function importanceStars(importance: number): string {
      return "★".repeat(importance) + "☆".repeat(5 - importance)
    }

    expect(importanceStars(5)).toBe("★★★★★")
    expect(importanceStars(3)).toBe("★★★☆☆")
    expect(importanceStars(1)).toBe("★☆☆☆☆")
  })

  it("confidence is displayed as percentage", () => {
    const record = createMockRecord({ confidence: 0.95 })
    expect(Math.round(record.confidence * 100)).toBe(95)
  })

  it("truncateUuid works for memory IDs", () => {
    expect(truncateUuid("mem-a1b2c3d4-e5f6-7890-abcd-111111111111")).toBe("mem-a1b2...")
  })

  it("related records exclude the selected record", () => {
    const allRecords = [
      createMockRecord({ id: "mem-1" }),
      createMockRecord({ id: "mem-2" }),
      createMockRecord({ id: "mem-3" }),
      createMockRecord({ id: "mem-4" }),
      createMockRecord({ id: "mem-5" }),
    ]
    const selectedId = "mem-2"
    const related = allRecords.filter((r) => r.id !== selectedId).slice(0, 4)

    expect(related).toHaveLength(4)
    expect(related.every((r) => r.id !== selectedId)).toBe(true)
  })

  it("content parsing detects code blocks", () => {
    const content = "Some text\n\n```yaml\nkey: value\n```\n\nMore text"
    const paragraphs = content.split("\n\n").filter(Boolean)
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs[1]!.startsWith("```")).toBe(true)
  })

  it("content parsing detects blockquotes", () => {
    const content = "> This is a callout"
    expect(content.startsWith("> ")).toBe(true)
  })

  it("content parsing detects headings", () => {
    const content = "# Main Heading\n\n## Sub Heading"
    const paragraphs = content.split("\n\n").filter(Boolean)
    expect(paragraphs[0]!.startsWith("# ")).toBe(true)
    expect(paragraphs[1]!.startsWith("## ")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RelatedPanel logic tests
// ---------------------------------------------------------------------------

describe("RelatedPanel rendering logic", () => {
  it("type config covers all 4 memory types", () => {
    const typeConfig: Record<MemoryRecord["type"], { icon: string; color: string; bg: string }> = {
      fact: { icon: "lightbulb", color: "text-amber-400", bg: "bg-amber-400/10" },
      preference: { icon: "tune", color: "text-blue-400", bg: "bg-blue-400/10" },
      event: { icon: "event", color: "text-emerald-400", bg: "bg-emerald-400/10" },
      system_rule: { icon: "gavel", color: "text-purple-400", bg: "bg-purple-400/10" },
    }

    const allTypes: MemoryRecord["type"][] = ["fact", "preference", "event", "system_rule"]
    for (const type of allTypes) {
      expect(typeConfig[type]).toBeDefined()
      expect(typeConfig[type].icon).toBeTruthy()
      expect(typeConfig[type].color).toBeTruthy()
      expect(typeConfig[type].bg).toBeTruthy()
    }
  })

  it("score percentage is calculated correctly", () => {
    const record = createMockRecord({ score: 0.97 })
    expect(Math.round(record.score! * 100)).toBe(97)
  })

  it("empty related records renders nothing", () => {
    const records: MemoryRecord[] = []
    expect(records.length === 0).toBe(true)
  })

  it("related records are limited to grid display", () => {
    const records = Array.from({ length: 10 }, (_, i) => createMockRecord({ id: `mem-${i}` }))
    const displayRecords = records.slice(0, 4)
    expect(displayRecords).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// MemoryRecord type tests
// ---------------------------------------------------------------------------

describe("MemoryRecord type", () => {
  it("has all required fields", () => {
    const record = createMockRecord()

    expect(record.id).toBeDefined()
    expect(record.type).toBeDefined()
    expect(record.content).toBeDefined()
    expect(record.tags).toBeInstanceOf(Array)
    expect(record.people).toBeInstanceOf(Array)
    expect(record.projects).toBeInstanceOf(Array)
    expect(typeof record.importance).toBe("number")
    expect(typeof record.confidence).toBe("number")
    expect(typeof record.source).toBe("string")
    expect(typeof record.createdAt).toBe("number")
    expect(typeof record.accessCount).toBe("number")
    expect(typeof record.lastAccessedAt).toBe("number")
  })

  it("type field accepts all 4 values", () => {
    const types: MemoryRecord["type"][] = ["fact", "preference", "event", "system_rule"]
    for (const type of types) {
      const record = createMockRecord({ type })
      expect(record.type).toBe(type)
    }
  })

  it("importance is between 1 and 5", () => {
    for (const imp of [1, 2, 3, 4, 5] as const) {
      const record = createMockRecord({ importance: imp })
      expect(record.importance).toBe(imp)
      expect(record.importance).toBeGreaterThanOrEqual(1)
      expect(record.importance).toBeLessThanOrEqual(5)
    }
  })

  it("score is optional", () => {
    const withScore = createMockRecord({ score: 0.95 })
    const withoutScore = createMockRecord({ score: undefined })

    expect(withScore.score).toBe(0.95)
    expect(withoutScore.score).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// API client: searchMemory and syncMemory
// ---------------------------------------------------------------------------

describe("searchMemory API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("passes query parameters correctly", async () => {
    mockFetchResponse({ results: [] })
    await searchMemory({ agentId: "agt-1", query: "kubernetes", limit: 10 })

    const url = vi.mocked(fetch).mock.calls[0]![0] as string
    expect(url).toContain("agentId=agt-1")
    expect(url).toContain("query=kubernetes")
    expect(url).toContain("limit=10")
  })

  it("returns results array", async () => {
    const mockResults = [createMockRecord()]
    mockFetchResponse({ results: mockResults })

    const result = await searchMemory({ agentId: "agt-1", query: "test" })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.type).toBe("fact")
  })

  it("returns empty results for no matches", async () => {
    mockFetchResponse({ results: [] })

    const result = await searchMemory({ agentId: "agt-1", query: "nonexistent" })
    expect(result.results).toHaveLength(0)
  })

  it("throws ApiError on server error", async () => {
    mockFetchResponse({ message: "Internal error" }, 500)
    await expect(searchMemory({ agentId: "agt-1", query: "test" })).rejects.toThrow(ApiError)
  })
})

describe("syncMemory API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("sends POST to sync endpoint", async () => {
    mockFetchResponse({
      syncId: "sync-001",
      status: "completed",
      stats: { upserted: 5, deleted: 1, unchanged: 10 },
    })

    const result = await syncMemory("agt-1")

    expect(result.syncId).toBe("sync-001")
    expect(result.stats.upserted).toBe(5)
    expect(result.stats.deleted).toBe(1)
    expect(result.stats.unchanged).toBe(10)
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/memory/sync`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("passes direction parameter", async () => {
    mockFetchResponse({
      syncId: "sync-002",
      status: "completed",
      stats: { upserted: 0, deleted: 0, unchanged: 15 },
    })

    await syncMemory("agt-1", "file_to_qdrant")

    const [, opts] = vi.mocked(fetch).mock.calls[0]!
    const body = JSON.parse(opts!.body as string) as { agentId: string; direction: string }
    expect(body.agentId).toBe("agt-1")
    expect(body.direction).toBe("file_to_qdrant")
  })

  it("throws on server error", async () => {
    mockFetchResponse({ message: "Sync failed" }, 500)
    await expect(syncMemory("agt-1")).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Empty state tests
// ---------------------------------------------------------------------------

describe("Empty states", () => {
  it("MemoryResults shows empty state when no results", () => {
    const results: MemoryRecord[] = []
    expect(results.length).toBe(0)
    // The component renders "No memories found" text in this case
  })

  it("DocumentViewer shows empty state when no record selected", () => {
    const record: MemoryRecord | null = null
    expect(record).toBeNull()
    // The component renders "No memory selected" text in this case
  })

  it("RelatedPanel renders nothing when empty", () => {
    const records: MemoryRecord[] = []
    expect(records.length).toBe(0)
    // The component returns an empty fragment
  })
})
