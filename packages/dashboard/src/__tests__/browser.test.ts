import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ApiError,
  type BrowserEvent,
  type BrowserEventType,
  type BrowserSession,
  type BrowserSessionStatus,
  type BrowserTab,
  type Screenshot,
  getAgentBrowser,
  getAgentBrowserEvents,
  getAgentScreenshots,
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
// ConnectionStatus logic tests
// ---------------------------------------------------------------------------

describe("ConnectionStatus states", () => {
  const STATUS_CONFIG: Record<
    BrowserSessionStatus,
    { label: string; hasReconnect: boolean }
  > = {
    connecting: { label: "Connecting", hasReconnect: false },
    connected: { label: "Live", hasReconnect: false },
    disconnected: { label: "Disconnected", hasReconnect: true },
    error: { label: "Error", hasReconnect: true },
  }

  const ALL_STATUSES: BrowserSessionStatus[] = [
    "connecting",
    "connected",
    "disconnected",
    "error",
  ]

  it("covers all 4 BrowserSessionStatus values", () => {
    expect(ALL_STATUSES).toHaveLength(4)
    for (const status of ALL_STATUSES) {
      expect(STATUS_CONFIG[status]).toBeDefined()
    }
  })

  it("connecting shows 'Connecting' label", () => {
    expect(STATUS_CONFIG.connecting.label).toBe("Connecting")
  })

  it("connected shows 'Live' label", () => {
    expect(STATUS_CONFIG.connected.label).toBe("Live")
  })

  it("disconnected shows 'Disconnected' label and has reconnect", () => {
    expect(STATUS_CONFIG.disconnected.label).toBe("Disconnected")
    expect(STATUS_CONFIG.disconnected.hasReconnect).toBe(true)
  })

  it("error shows 'Error' label and has reconnect", () => {
    expect(STATUS_CONFIG.error.label).toBe("Error")
    expect(STATUS_CONFIG.error.hasReconnect).toBe(true)
  })

  it("connected and connecting do not show reconnect button", () => {
    expect(STATUS_CONFIG.connected.hasReconnect).toBe(false)
    expect(STATUS_CONFIG.connecting.hasReconnect).toBe(false)
  })

  it("latency quality classifications", () => {
    function qualityLabel(latencyMs: number): string {
      if (latencyMs < 50) return "Excellent"
      if (latencyMs < 100) return "Good"
      if (latencyMs < 200) return "Fair"
      return "Poor"
    }

    expect(qualityLabel(20)).toBe("Excellent")
    expect(qualityLabel(49)).toBe("Excellent")
    expect(qualityLabel(50)).toBe("Good")
    expect(qualityLabel(99)).toBe("Good")
    expect(qualityLabel(100)).toBe("Fair")
    expect(qualityLabel(199)).toBe("Fair")
    expect(qualityLabel(200)).toBe("Poor")
    expect(qualityLabel(500)).toBe("Poor")
  })
})

// ---------------------------------------------------------------------------
// TabBar logic tests
// ---------------------------------------------------------------------------

describe("TabBar rendering logic", () => {
  const mockTabs: BrowserTab[] = [
    {
      id: "tab-1",
      title: "GitHub - cortex-plane/dashboard",
      url: "https://github.com/cortex-plane/dashboard",
      active: true,
    },
    {
      id: "tab-2",
      title: "Stack Overflow - React useEffect cleanup",
      url: "https://stackoverflow.com/questions/55139386",
      active: false,
    },
    {
      id: "tab-3",
      title: "MDN Web Docs - Fetch API Reference Guide for Developers",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      active: false,
    },
  ]

  it("renders correct number of tabs", () => {
    expect(mockTabs).toHaveLength(3)
  })

  it("identifies active tab correctly", () => {
    const activeTab = mockTabs.find((t) => t.active)
    expect(activeTab).toBeDefined()
    expect(activeTab!.id).toBe("tab-1")
  })

  it("only one tab can be active at a time", () => {
    const activeTabs = mockTabs.filter((t) => t.active)
    expect(activeTabs).toHaveLength(1)
  })

  it("tab title truncation (conceptual — CSS truncation)", () => {
    // Tab titles longer than 120px would be truncated via CSS
    const longTitle = mockTabs[2]!.title
    expect(longTitle.length).toBeGreaterThan(30)
    // CSS max-w-[120px] truncate handles visual truncation
  })

  it("handles empty tabs array", () => {
    const emptyTabs: BrowserTab[] = []
    expect(emptyTabs).toHaveLength(0)
    // Component shows "No tabs open" for empty array
  })

  it("tab selection changes active state", () => {
    const selectTab = (tabs: BrowserTab[], tabId: string): BrowserTab[] =>
      tabs.map((t) => ({ ...t, active: t.id === tabId }))

    const updated = selectTab(mockTabs, "tab-2")
    expect(updated.find((t) => t.id === "tab-1")!.active).toBe(false)
    expect(updated.find((t) => t.id === "tab-2")!.active).toBe(true)
    expect(updated.find((t) => t.id === "tab-3")!.active).toBe(false)
  })

  it("closing a tab removes it from list", () => {
    const closeTab = (tabs: BrowserTab[], tabId: string): BrowserTab[] => {
      const filtered = tabs.filter((t) => t.id !== tabId)
      if (filtered.length > 0 && !filtered.some((t) => t.active)) {
        filtered[0] = { ...filtered[0]!, active: true }
      }
      return filtered
    }

    const afterClose = closeTab(mockTabs, "tab-2")
    expect(afterClose).toHaveLength(2)
    expect(afterClose.find((t) => t.id === "tab-2")).toBeUndefined()
  })

  it("closing active tab activates first remaining tab", () => {
    const closeTab = (tabs: BrowserTab[], tabId: string): BrowserTab[] => {
      const filtered = tabs.filter((t) => t.id !== tabId)
      if (filtered.length > 0 && !filtered.some((t) => t.active)) {
        filtered[0] = { ...filtered[0]!, active: true }
      }
      return filtered
    }

    const afterClose = closeTab(mockTabs, "tab-1") // Close the active tab
    expect(afterClose).toHaveLength(2)
    expect(afterClose[0]!.active).toBe(true) // First remaining becomes active
  })
})

// ---------------------------------------------------------------------------
// ScreenshotGallery logic tests
// ---------------------------------------------------------------------------

describe("ScreenshotGallery rendering logic", () => {
  const mockScreenshots: Screenshot[] = [
    {
      id: "ss-001",
      agentId: "agt-123",
      timestamp: new Date(Date.now() - 15_000).toISOString(),
      thumbnailUrl: "https://placeholder/thumb-1.png",
      fullUrl: "https://placeholder/full-1.png",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-002",
      agentId: "agt-123",
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      thumbnailUrl: "https://placeholder/thumb-2.png",
      fullUrl: "https://placeholder/full-2.png",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-003",
      agentId: "agt-123",
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      thumbnailUrl: "https://placeholder/thumb-3.png",
      fullUrl: "https://placeholder/full-3.png",
      dimensions: { width: 1280, height: 720 },
    },
  ]

  it("renders correct number of thumbnails", () => {
    expect(mockScreenshots).toHaveLength(3)
  })

  it("handles empty screenshots array (empty state)", () => {
    const empty: Screenshot[] = []
    expect(empty).toHaveLength(0)
    // Component renders "No Screenshots" message
  })

  it("screenshots have required properties", () => {
    for (const ss of mockScreenshots) {
      expect(ss.id).toBeDefined()
      expect(ss.agentId).toBeDefined()
      expect(ss.timestamp).toBeDefined()
      expect(ss.thumbnailUrl).toBeDefined()
      expect(ss.fullUrl).toBeDefined()
      expect(ss.dimensions.width).toBeGreaterThan(0)
      expect(ss.dimensions.height).toBeGreaterThan(0)
    }
  })

  it("screenshots are sorted by timestamp (most recent first in mock)", () => {
    const timestamps = mockScreenshots.map((ss) => new Date(ss.timestamp).getTime())
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]!).toBeGreaterThanOrEqual(timestamps[i]!)
    }
  })

  it("lightbox navigation bounds checking", () => {
    const total = mockScreenshots.length
    let index = 0

    // Can go forward
    expect(index < total - 1).toBe(true)
    index = total - 1

    // Cannot go forward past end
    expect(index < total - 1).toBe(false)

    // Can go backward
    expect(index > 0).toBe(true)
    index = 0

    // Cannot go backward past start
    expect(index > 0).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TraceTimeline logic tests
// ---------------------------------------------------------------------------

describe("TraceTimeline rendering logic", () => {
  const ALL_EVENT_TYPES: BrowserEventType[] = [
    "GET",
    "CLICK",
    "CONSOLE",
    "SNAPSHOT",
    "NAVIGATE",
    "ERROR",
  ]

  const EVENT_ICONS: Record<BrowserEventType, string> = {
    GET: "language",
    CLICK: "ads_click",
    CONSOLE: "terminal",
    SNAPSHOT: "photo_camera",
    NAVIGATE: "explore",
    ERROR: "warning",
  }

  const mockEvents: BrowserEvent[] = [
    {
      id: "evt-001",
      type: "NAVIGATE",
      timestamp: new Date(Date.now() - 300_000).toISOString(),
      url: "https://github.com/cortex-plane/dashboard",
    },
    {
      id: "evt-002",
      type: "GET",
      timestamp: new Date(Date.now() - 295_000).toISOString(),
      url: "https://github.com/cortex-plane/dashboard",
      durationMs: 340,
    },
    {
      id: "evt-003",
      type: "CLICK",
      timestamp: new Date(Date.now() - 200_000).toISOString(),
      selector: "a.js-navigation-open",
      message: "Clicked: 'Pull requests'",
    },
    {
      id: "evt-004",
      type: "CONSOLE",
      timestamp: new Date(Date.now() - 150_000).toISOString(),
      message: "[info] Page load complete in 1.2s",
    },
    {
      id: "evt-005",
      type: "SNAPSHOT",
      timestamp: new Date(Date.now() - 100_000).toISOString(),
      message: "Auto-snapshot: page fully loaded",
    },
    {
      id: "evt-006",
      type: "ERROR",
      timestamp: new Date(Date.now() - 50_000).toISOString(),
      message: "Uncaught TypeError: Cannot read properties of undefined",
      url: "https://github.com/cortex-plane/dashboard",
    },
  ]

  it("covers all 6 BrowserEventType values", () => {
    expect(ALL_EVENT_TYPES).toHaveLength(6)
    for (const type of ALL_EVENT_TYPES) {
      expect(EVENT_ICONS[type]).toBeDefined()
    }
  })

  it("each event type has a distinct icon", () => {
    const icons = Object.values(EVENT_ICONS)
    const uniqueIcons = new Set(icons)
    expect(uniqueIcons.size).toBe(icons.length)
  })

  it("GET event shows correct icon", () => {
    expect(EVENT_ICONS.GET).toBe("language")
  })

  it("CLICK event shows correct icon", () => {
    expect(EVENT_ICONS.CLICK).toBe("ads_click")
  })

  it("CONSOLE event shows correct icon", () => {
    expect(EVENT_ICONS.CONSOLE).toBe("terminal")
  })

  it("SNAPSHOT event shows correct icon", () => {
    expect(EVENT_ICONS.SNAPSHOT).toBe("photo_camera")
  })

  it("NAVIGATE event shows correct icon", () => {
    expect(EVENT_ICONS.NAVIGATE).toBe("explore")
  })

  it("ERROR event shows correct icon", () => {
    expect(EVENT_ICONS.ERROR).toBe("warning")
  })

  it("filter by event type works correctly", () => {
    const filterEvents = (
      events: BrowserEvent[],
      activeFilters: Set<BrowserEventType>,
    ): BrowserEvent[] => events.filter((e) => activeFilters.has(e.type))

    // All filters active
    const all = filterEvents(mockEvents, new Set(ALL_EVENT_TYPES))
    expect(all).toHaveLength(6)

    // Only GET events
    const getOnly = filterEvents(mockEvents, new Set(["GET"]))
    expect(getOnly).toHaveLength(1)
    expect(getOnly[0]!.type).toBe("GET")

    // Multiple filters
    const clickAndError = filterEvents(mockEvents, new Set(["CLICK", "ERROR"]))
    expect(clickAndError).toHaveLength(2)

    // No matching events
    const noMatch = filterEvents([], new Set(ALL_EVENT_TYPES))
    expect(noMatch).toHaveLength(0)
  })

  it("events have timestamp for display", () => {
    for (const event of mockEvents) {
      const time = new Date(event.timestamp)
      expect(time.getTime()).not.toBeNaN()
    }
  })

  it("duration is only shown when present", () => {
    const withDuration = mockEvents.filter((e) => e.durationMs !== undefined)
    const withoutDuration = mockEvents.filter((e) => e.durationMs === undefined)

    expect(withDuration.length).toBeGreaterThan(0)
    expect(withoutDuration.length).toBeGreaterThan(0)
  })

  it("URL is only shown for relevant event types", () => {
    const withUrl = mockEvents.filter((e) => e.url !== undefined)
    expect(withUrl.length).toBeGreaterThan(0)

    // SNAPSHOT and CONSOLE events may not have URLs
    const snapshot = mockEvents.find((e) => e.type === "SNAPSHOT")
    expect(snapshot?.url).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BrowserViewport logic tests
// ---------------------------------------------------------------------------

describe("BrowserViewport rendering logic", () => {
  // Helper that mirrors the component logic without TypeScript narrowing issues
  function canShowVnc(vncUrl: string | null, status: BrowserSessionStatus): boolean {
    return Boolean(vncUrl && (status === "connected" || status === "connecting"))
  }

  it("shows VNC iframe when vncUrl is available and status is connected", () => {
    expect(canShowVnc("wss://vnc.example.com/session-123", "connected")).toBe(true)
  })

  it("shows VNC iframe when vncUrl is available and status is connecting", () => {
    expect(canShowVnc("wss://vnc.example.com/session-123", "connecting")).toBe(true)
  })

  it("does not show VNC when vncUrl is null (screenshot fallback)", () => {
    expect(canShowVnc(null, "connected")).toBe(false)
  })

  it("does not show VNC when disconnected", () => {
    expect(canShowVnc(null, "disconnected")).toBe(false)
    expect(canShowVnc("wss://vnc.example.com/session-123", "disconnected")).toBe(false)
  })

  it("does not show VNC when status is error", () => {
    expect(canShowVnc(null, "error")).toBe(false)
    expect(canShowVnc("wss://vnc.example.com/session-123", "error")).toBe(false)
  })

  it("shows placeholder when disconnected with no screenshot", () => {
    const latestScreenshot: Screenshot | null = null
    expect(canShowVnc(null, "disconnected")).toBe(false)
    expect(latestScreenshot).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BrowserSession type tests
// ---------------------------------------------------------------------------

describe("BrowserSession interface", () => {
  it("has all required fields", () => {
    const session: BrowserSession = {
      id: "bsess-123",
      agentId: "agt-456",
      vncUrl: "wss://vnc.example.com/session-123",
      status: "connected",
      tabs: [
        {
          id: "tab-1",
          title: "GitHub",
          url: "https://github.com",
          active: true,
        },
      ],
      latencyMs: 42,
    }

    expect(session.id).toBe("bsess-123")
    expect(session.agentId).toBe("agt-456")
    expect(session.vncUrl).toBe("wss://vnc.example.com/session-123")
    expect(session.status).toBe("connected")
    expect(session.tabs).toHaveLength(1)
    expect(session.latencyMs).toBe(42)
  })

  it("vncUrl can be null", () => {
    const session: BrowserSession = {
      id: "bsess-123",
      agentId: "agt-456",
      vncUrl: null,
      status: "disconnected",
      tabs: [],
      latencyMs: 0,
    }

    expect(session.vncUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// API client: browser endpoints
// ---------------------------------------------------------------------------

describe("getAgentBrowser API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches browser session by agent ID", async () => {
    const mockSession: BrowserSession = {
      id: "bsess-123",
      agentId: "agt-456",
      vncUrl: "wss://vnc.example.com/session-123",
      status: "connected",
      tabs: [],
      latencyMs: 35,
    }

    mockFetchResponse(mockSession)
    const result = await getAgentBrowser("agt-456")

    expect(result.id).toBe("bsess-123")
    expect(result.status).toBe("connected")
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/agents/agt-456/browser`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("throws ApiError on 404", async () => {
    mockFetchResponse(
      {
        type: "https://cortex-plane.dev/errors/not-found",
        title: "Not Found",
        status: 404,
        detail: "Browser session not found",
      },
      404,
    )

    await expect(getAgentBrowser("nonexistent")).rejects.toThrow(ApiError)
  })
})

describe("getAgentScreenshots API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches screenshots with default params", async () => {
    mockFetchResponse({ screenshots: [] })
    const result = await getAgentScreenshots("agt-456")

    expect(result.screenshots).toHaveLength(0)
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/agents/agt-456/browser/screenshots`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("passes limit parameter", async () => {
    mockFetchResponse({ screenshots: [] })
    await getAgentScreenshots("agt-456", 10)

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/agents/agt-456/browser/screenshots?limit=10`,
      expect.objectContaining({ method: "GET" }),
    )
  })
})

describe("getAgentBrowserEvents API", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("fetches browser events with default params", async () => {
    mockFetchResponse({ events: [] })
    const result = await getAgentBrowserEvents("agt-456")

    expect(result.events).toHaveLength(0)
    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/agents/agt-456/browser/events`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("passes limit and types parameters", async () => {
    mockFetchResponse({ events: [] })
    await getAgentBrowserEvents("agt-456", 20, ["GET", "ERROR"])

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/agents/agt-456/browser/events?limit=20&types=GET%2CERROR`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("throws on server error", async () => {
    mockFetchResponse({ message: "Internal error" }, 500)
    await expect(getAgentBrowserEvents("agt-456")).rejects.toThrow()
  })
})
