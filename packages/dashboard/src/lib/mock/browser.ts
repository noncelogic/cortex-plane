import type { BrowserEvent, BrowserSession, BrowserTab, Screenshot } from "@/lib/schemas/browser"

export function mockBrowserSession(agentId: string): BrowserSession {
  return {
    id: `bsess-${agentId.slice(0, 8)}`,
    agentId,
    vncUrl: null,
    status: "connected",
    tabs: mockTabs(),
    latencyMs: 42,
    lastHeartbeat: new Date(Date.now() - 3000).toISOString(),
  }
}

export function mockTabs(): BrowserTab[] {
  return [
    {
      id: "tab-1",
      title: "GitHub - cortex-plane/dashboard",
      url: "https://github.com/cortex-plane/dashboard",
      active: true,
    },
    {
      id: "tab-2",
      title: "Stack Overflow - React useEffect cleanup",
      url: "https://stackoverflow.com/questions/55139386/react-useeffect-cleanup",
      active: false,
    },
    {
      id: "tab-3",
      title: "MDN Web Docs - Fetch API",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      active: false,
    },
    {
      id: "tab-4",
      title: "Tailwind CSS - Utility-First Fundamentals",
      url: "https://tailwindcss.com/docs/utility-first",
      active: false,
    },
  ]
}

export function mockScreenshots(agentId: string): Screenshot[] {
  const now = Date.now()
  return [
    {
      id: "ss-001",
      agentId,
      timestamp: new Date(now - 15_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EGitHub Dashboard%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EGitHub - cortex-plane/dashboard%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-002",
      agentId,
      timestamp: new Date(now - 45_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EStack Overflow%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EStack Overflow - React useEffect%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-003",
      agentId,
      timestamp: new Date(now - 120_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EMDN Fetch API%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EMDN - Fetch API Documentation%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-004",
      agentId,
      timestamp: new Date(now - 300_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3ETailwind Docs%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3ETailwind CSS Documentation%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-005",
      agentId,
      timestamp: new Date(now - 600_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EGoogle Search%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EGoogle Search Results%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-006",
      agentId,
      timestamp: new Date(now - 900_000).toISOString(),
      thumbnailUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EVercel Dashboard%3C/text%3E%3C/svg%3E",
      fullUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EVercel Deployment Dashboard%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
  ]
}

export function mockBrowserEvents(): BrowserEvent[] {
  const now = Date.now()
  return [
    {
      id: "evt-001",
      type: "NAVIGATE",
      timestamp: new Date(now - 900_000).toISOString(),
      url: "https://www.google.com/search?q=react+useEffect+best+practices",
    },
    {
      id: "evt-002",
      type: "GET",
      timestamp: new Date(now - 895_000).toISOString(),
      url: "https://www.google.com/search?q=react+useEffect+best+practices",
      durationMs: 340,
    },
    {
      id: "evt-003",
      type: "CLICK",
      timestamp: new Date(now - 860_000).toISOString(),
      selector: "a[href*='stackoverflow.com'] h3",
      message: "Clicked: 'React useEffect cleanup function'",
    },
    {
      id: "evt-004",
      type: "NAVIGATE",
      timestamp: new Date(now - 858_000).toISOString(),
      url: "https://stackoverflow.com/questions/55139386/react-useeffect-cleanup",
    },
    {
      id: "evt-005",
      type: "GET",
      timestamp: new Date(now - 855_000).toISOString(),
      url: "https://stackoverflow.com/questions/55139386/react-useeffect-cleanup",
      durationMs: 520,
    },
    {
      id: "evt-006",
      type: "SNAPSHOT",
      timestamp: new Date(now - 600_000).toISOString(),
      message: "Auto-snapshot: page fully loaded",
    },
    {
      id: "evt-007",
      type: "CONSOLE",
      timestamp: new Date(now - 550_000).toISOString(),
      message: "[info] Cookie consent banner detected, dismissing...",
    },
    {
      id: "evt-008",
      type: "CLICK",
      timestamp: new Date(now - 540_000).toISOString(),
      selector: "button.js-accept-cookies",
      message: "Clicked: 'Accept all cookies'",
    },
    {
      id: "evt-009",
      type: "NAVIGATE",
      timestamp: new Date(now - 320_000).toISOString(),
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    },
    {
      id: "evt-010",
      type: "GET",
      timestamp: new Date(now - 318_000).toISOString(),
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      durationMs: 280,
    },
    {
      id: "evt-011",
      type: "CONSOLE",
      timestamp: new Date(now - 300_000).toISOString(),
      message: "[debug] Extracting code examples from documentation page",
    },
    {
      id: "evt-012",
      type: "ERROR",
      timestamp: new Date(now - 180_000).toISOString(),
      message: "Uncaught TypeError: Cannot read properties of undefined (reading 'json')",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    },
    {
      id: "evt-013",
      type: "NAVIGATE",
      timestamp: new Date(now - 120_000).toISOString(),
      url: "https://github.com/cortex-plane/dashboard/pulls",
    },
    {
      id: "evt-014",
      type: "GET",
      timestamp: new Date(now - 118_000).toISOString(),
      url: "https://github.com/cortex-plane/dashboard/pulls",
      durationMs: 410,
    },
    {
      id: "evt-015",
      type: "CLICK",
      timestamp: new Date(now - 60_000).toISOString(),
      selector: "a.js-navigation-open[data-hovercard-type='pull_request']",
      message: "Clicked: 'feat(dashboard): Browser observation panel (#78)'",
    },
    {
      id: "evt-016",
      type: "SNAPSHOT",
      timestamp: new Date(now - 15_000).toISOString(),
      message: "Manual snapshot requested by operator",
    },
  ]
}
