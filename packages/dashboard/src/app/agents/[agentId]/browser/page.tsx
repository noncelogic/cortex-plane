"use client"

import Link from "next/link"
import { use, useMemo, useState } from "react"

import { BrowserViewport } from "@/components/browser/browser-viewport"
import { ScreenshotGallery } from "@/components/browser/screenshot-gallery"
import { TabBar } from "@/components/browser/tab-bar"
import { TraceTimeline } from "@/components/browser/trace-timeline"
import { useApiQuery } from "@/hooks/use-api"
import type {
  BrowserEvent,
  BrowserSession,
  BrowserTab,
  Screenshot,
} from "@/lib/api-client"
import { getAgent, getAgentBrowser, getAgentBrowserEvents, getAgentScreenshots } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function mockBrowserSession(agentId: string): BrowserSession {
  return {
    id: `bsess-${agentId.slice(0, 8)}`,
    agentId,
    vncUrl: null, // VNC not available in mock — will show screenshot fallback
    status: "connected",
    tabs: mockTabs(),
    latencyMs: 42,
    lastHeartbeat: new Date(Date.now() - 3000).toISOString(),
  }
}

function mockTabs(): BrowserTab[] {
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

function mockScreenshots(agentId: string): Screenshot[] {
  const now = Date.now()
  return [
    {
      id: "ss-001",
      agentId,
      timestamp: new Date(now - 15_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EGitHub Dashboard%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EGitHub - cortex-plane/dashboard%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-002",
      agentId,
      timestamp: new Date(now - 45_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EStack Overflow%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EStack Overflow - React useEffect%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-003",
      agentId,
      timestamp: new Date(now - 120_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EMDN Fetch API%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EMDN - Fetch API Documentation%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-004",
      agentId,
      timestamp: new Date(now - 300_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3ETailwind Docs%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3ETailwind CSS Documentation%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-005",
      agentId,
      timestamp: new Date(now - 600_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EGoogle Search%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EGoogle Search Results%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      id: "ss-006",
      agentId,
      timestamp: new Date(now - 900_000).toISOString(),
      thumbnailUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' fill='%23161622'%3E%3Crect width='320' height='180'/%3E%3Ctext x='160' y='90' text-anchor='middle' fill='%23444' font-size='14' font-family='monospace'%3EVercel Dashboard%3C/text%3E%3C/svg%3E",
      fullUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080' fill='%23161622'%3E%3Crect width='1920' height='1080'/%3E%3Ctext x='960' y='540' text-anchor='middle' fill='%23555' font-size='24' font-family='monospace'%3EVercel Deployment Dashboard%3C/text%3E%3C/svg%3E",
      dimensions: { width: 1920, height: 1080 },
    },
  ]
}

function mockBrowserEvents(): BrowserEvent[] {
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

// ---------------------------------------------------------------------------
// Mobile tabs
// ---------------------------------------------------------------------------

const MOBILE_TABS = ["Viewport", "Screenshots", "Trace"] as const
type MobileTab = (typeof MOBILE_TABS)[number]

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

interface BrowserPageProps {
  params: Promise<{ agentId: string }>
}

export default function BrowserPage({ params }: BrowserPageProps): React.JSX.Element {
  const { agentId } = use(params)
  const [mobileTab, setMobileTab] = useState<MobileTab>("Viewport")
  const [tabs, setTabs] = useState<BrowserTab[]>(() => mockTabs())
  const [galleryOpen, setGalleryOpen] = useState(true)

  // Attempt real API fetches; fall back to mock data
  const { data: agentData, error: agentError } = useApiQuery(() => getAgent(agentId), [agentId])
  const { data: sessionData, error: sessionError } = useApiQuery(
    () => getAgentBrowser(agentId),
    [agentId],
  )
  const { data: screenshotData, error: screenshotError } = useApiQuery(
    () => getAgentScreenshots(agentId),
    [agentId],
  )
  const { data: eventData, error: eventError } = useApiQuery(
    () => getAgentBrowserEvents(agentId),
    [agentId],
  )

  // Fall back to mock data when API is unavailable
  const session: BrowserSession = sessionData ?? (sessionError ? mockBrowserSession(agentId) : mockBrowserSession(agentId))
  const screenshots: Screenshot[] = useMemo(
    () => screenshotData?.screenshots ?? (screenshotError ? mockScreenshots(agentId) : mockScreenshots(agentId)),
    [screenshotData, screenshotError, agentId],
  )
  const events: BrowserEvent[] = useMemo(
    () => eventData?.events ?? (eventError ? mockBrowserEvents() : mockBrowserEvents()),
    [eventData, eventError],
  )

  const agentName = agentData?.name ?? (agentError ? `Agent ${agentId.slice(0, 8)}` : `Agent ${agentId.slice(0, 8)}`)

  const handleSelectTab = (tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => ({ ...t, active: t.id === tabId })),
    )
  }

  const handleCloseTab = (tabId: string) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId)
      // If we closed the active tab, activate the first remaining
      if (filtered.length > 0 && !filtered.some((t) => t.active)) {
        filtered[0] = { ...filtered[0]!, active: true }
      }
      return filtered
    })
  }

  const handleReconnect = () => {
    // In production this would re-establish the VNC connection
  }

  const latestScreenshot = screenshots.length > 0 ? screenshots[0]! : null

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      {/* Breadcrumb: Agents > [Agent Name] > Browser */}
      <nav className="flex items-center gap-2 text-sm">
        <Link
          href="/agents"
          className="text-slate-400 transition-colors hover:text-primary"
        >
          Agents
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <Link
          href={`/agents/${agentId}`}
          className="text-slate-400 transition-colors hover:text-primary"
        >
          {agentName}
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <span className="flex items-center gap-1.5 font-bold text-white">
          <span className="material-symbols-outlined text-sm text-primary">web</span>
          Browser
        </span>
      </nav>

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <span className="material-symbols-outlined text-lg text-primary">web</span>
          </div>
          <div>
            <h1 className="font-display text-xl font-black tracking-tight text-white lg:text-2xl">
              Browser Observation
            </h1>
            <p className="text-xs text-slate-500">
              {session.status === "connected"
                ? `Live session · ${session.latencyMs}ms latency`
                : session.lastHeartbeat
                  ? `Last active ${relativeTime(session.lastHeartbeat)}`
                  : "No active session"}
            </p>
          </div>
        </div>
      </div>

      {/* Mobile tabs */}
      <div className="sticky top-0 z-40 -mx-4 border-b border-[#2d2d3b] bg-[#111118]/50 backdrop-blur lg:hidden">
        <div className="flex">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setMobileTab(tab)}
              className={`flex-1 py-3 text-sm font-medium transition-colors ${
                mobileTab === tab
                  ? "border-b-2 border-primary text-primary"
                  : "border-b-2 border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop: 3-column layout */}
      <div className="hidden flex-1 gap-6 lg:flex">
        {/* Main viewport area */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Tab bar above viewport */}
          <TabBar tabs={tabs} onSelectTab={handleSelectTab} onCloseTab={handleCloseTab} />

          <BrowserViewport
            vncUrl={session.vncUrl}
            status={session.status}
            latencyMs={session.latencyMs}
            latestScreenshot={latestScreenshot}
            onReconnect={handleReconnect}
          />

          {/* Screenshot gallery (collapsible) */}
          <div className="rounded-xl border border-[#2d2d3b] bg-[#1c1c27]">
            <button
              type="button"
              onClick={() => setGalleryOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-slate-400">
                  photo_library
                </span>
                <span className="text-sm font-bold text-slate-300">Screenshots</span>
                <span className="rounded-md bg-[#282839] px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                  {screenshots.length}
                </span>
              </div>
              <span className="material-symbols-outlined text-lg text-slate-500 transition-transform">
                {galleryOpen ? "expand_less" : "expand_more"}
              </span>
            </button>
            {galleryOpen && (
              <div className="border-t border-[#2d2d3b] p-4">
                <ScreenshotGallery screenshots={screenshots} />
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar: trace timeline */}
        <div className="w-[360px] shrink-0">
          <div className="sticky top-6">
            <h3 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
              <span className="material-symbols-outlined text-sm text-primary">timeline</span>
              Trace Events
              <span className="rounded-md bg-[#282839] px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
                {events.length}
              </span>
            </h3>
            <TraceTimeline events={events} />
          </div>
        </div>
      </div>

      {/* Mobile: tab content */}
      <div className="flex flex-1 flex-col lg:hidden">
        {mobileTab === "Viewport" && (
          <div className="flex flex-col gap-4">
            {/* On mobile, show screenshots as primary if VNC unavailable */}
            {session.vncUrl ? (
              <BrowserViewport
                vncUrl={session.vncUrl}
                status={session.status}
                latencyMs={session.latencyMs}
                latestScreenshot={latestScreenshot}
                onReconnect={handleReconnect}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <ScreenshotGallery screenshots={screenshots} />
              </div>
            )}
            <TabBar
              tabs={tabs}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
            />
          </div>
        )}
        {mobileTab === "Screenshots" && (
          <ScreenshotGallery screenshots={screenshots} />
        )}
        {mobileTab === "Trace" && <TraceTimeline events={events} />}
      </div>
    </div>
  )
}
