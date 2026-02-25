import { describe, expect, it } from "vitest"

import { generateMockJobs } from "@/lib/mock/jobs"
import { generateMockContent } from "@/lib/mock/content"
import { generateMockMemories, MOCK_AGENT_ID } from "@/lib/mock/memory"
import { mockBrowserSession, mockTabs, mockScreenshots, mockBrowserEvents } from "@/lib/mock/browser"
import { isMockEnabled } from "@/lib/mock"

// ---------------------------------------------------------------------------
// Mock data generators
// ---------------------------------------------------------------------------

describe("isMockEnabled", () => {
  it("returns false by default", () => {
    expect(isMockEnabled()).toBe(false)
  })
})

describe("generateMockJobs", () => {
  it("returns 25 jobs", () => {
    const jobs = generateMockJobs()
    expect(jobs).toHaveLength(25)
  })

  it("generates unique IDs", () => {
    const jobs = generateMockJobs()
    const ids = new Set(jobs.map((j) => j.id))
    expect(ids.size).toBe(25)
  })

  it("includes all expected statuses", () => {
    const jobs = generateMockJobs()
    const statuses = new Set(jobs.map((j) => j.status))
    expect(statuses.has("COMPLETED")).toBe(true)
    expect(statuses.has("FAILED")).toBe(true)
    expect(statuses.has("RUNNING")).toBe(true)
  })

  it("sets error for FAILED jobs", () => {
    const jobs = generateMockJobs()
    const failed = jobs.filter((j) => j.status === "FAILED")
    expect(failed.length).toBeGreaterThan(0)
    for (const j of failed) {
      expect(j.error).toBeDefined()
    }
  })

  it("omits completedAt for running/pending jobs", () => {
    const jobs = generateMockJobs()
    const running = jobs.filter((j) => j.status === "RUNNING")
    for (const j of running) {
      expect(j.completedAt).toBeUndefined()
    }
  })
})

describe("generateMockContent", () => {
  it("returns 14 content pieces", () => {
    const pieces = generateMockContent()
    expect(pieces).toHaveLength(14)
  })

  it("includes all statuses", () => {
    const pieces = generateMockContent()
    const statuses = new Set(pieces.map((p) => p.status))
    expect(statuses.has("DRAFT")).toBe(true)
    expect(statuses.has("IN_REVIEW")).toBe(true)
    expect(statuses.has("QUEUED")).toBe(true)
    expect(statuses.has("PUBLISHED")).toBe(true)
  })

  it("published pieces have publishedAt", () => {
    const pieces = generateMockContent()
    const published = pieces.filter((p) => p.status === "PUBLISHED")
    for (const p of published) {
      expect(p.publishedAt).toBeDefined()
      expect(p.channel).toBeDefined()
    }
  })

  it("includes multiple content types", () => {
    const pieces = generateMockContent()
    const types = new Set(pieces.map((p) => p.type))
    expect(types.has("blog")).toBe(true)
    expect(types.has("social")).toBe(true)
    expect(types.has("newsletter")).toBe(true)
    expect(types.has("report")).toBe(true)
  })
})

describe("generateMockMemories", () => {
  it("returns 8 memory records", () => {
    const records = generateMockMemories()
    expect(records).toHaveLength(8)
  })

  it("includes all memory types", () => {
    const records = generateMockMemories()
    const types = new Set(records.map((r) => r.type))
    expect(types.has("fact")).toBe(true)
    expect(types.has("preference")).toBe(true)
    expect(types.has("event")).toBe(true)
    expect(types.has("system_rule")).toBe(true)
  })

  it("has valid importance values (1-5)", () => {
    const records = generateMockMemories()
    for (const r of records) {
      expect(r.importance).toBeGreaterThanOrEqual(1)
      expect(r.importance).toBeLessThanOrEqual(5)
    }
  })

  it("has confidence between 0 and 1", () => {
    const records = generateMockMemories()
    for (const r of records) {
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })

  it("exports MOCK_AGENT_ID", () => {
    expect(MOCK_AGENT_ID).toBe("agt-cortex-001")
  })
})

describe("mockBrowserSession", () => {
  it("creates session for given agentId", () => {
    const session = mockBrowserSession("agt-test-123")
    expect(session.agentId).toBe("agt-test-123")
    expect(session.status).toBe("connected")
    expect(session.vncUrl).toBeNull()
  })

  it("includes tabs", () => {
    const session = mockBrowserSession("agt-1")
    expect(session.tabs.length).toBeGreaterThan(0)
  })
})

describe("mockTabs", () => {
  it("returns 4 tabs", () => {
    const tabs = mockTabs()
    expect(tabs).toHaveLength(4)
  })

  it("has exactly one active tab", () => {
    const tabs = mockTabs()
    const active = tabs.filter((t) => t.active)
    expect(active).toHaveLength(1)
  })
})

describe("mockScreenshots", () => {
  it("returns 6 screenshots", () => {
    const screenshots = mockScreenshots("agt-1")
    expect(screenshots).toHaveLength(6)
  })

  it("sets agentId on all screenshots", () => {
    const screenshots = mockScreenshots("agt-test")
    for (const ss of screenshots) {
      expect(ss.agentId).toBe("agt-test")
    }
  })

  it("has dimensions on all screenshots", () => {
    const screenshots = mockScreenshots("agt-1")
    for (const ss of screenshots) {
      expect(ss.dimensions.width).toBe(1920)
      expect(ss.dimensions.height).toBe(1080)
    }
  })
})

describe("mockBrowserEvents", () => {
  it("returns 16 events", () => {
    const events = mockBrowserEvents()
    expect(events).toHaveLength(16)
  })

  it("includes multiple event types", () => {
    const events = mockBrowserEvents()
    const types = new Set(events.map((e) => e.type))
    expect(types.has("NAVIGATE")).toBe(true)
    expect(types.has("GET")).toBe(true)
    expect(types.has("CLICK")).toBe(true)
    expect(types.has("SNAPSHOT")).toBe(true)
    expect(types.has("CONSOLE")).toBe(true)
    expect(types.has("ERROR")).toBe(true)
  })

  it("has unique IDs", () => {
    const events = mockBrowserEvents()
    const ids = new Set(events.map((e) => e.id))
    expect(ids.size).toBe(16)
  })
})
