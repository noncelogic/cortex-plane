"use client"

import Link from "next/link"
import { use, useState } from "react"

import { BrowserViewport } from "@/components/browser/browser-viewport"
import { ScreenshotButton } from "@/components/browser/screenshot-button"
import { ScreenshotGallery } from "@/components/browser/screenshot-gallery"
import { TabBar } from "@/components/browser/tab-bar"
import { TraceControls } from "@/components/browser/trace-controls"
import { TraceTimeline } from "@/components/browser/trace-timeline"
import { useBrowserObservation } from "@/hooks/use-browser-observation"
import { relativeTime } from "@/lib/format"

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
  const [galleryOpen, setGalleryOpen] = useState(true)

  const {
    session,
    tabs,
    screenshots,
    events,
    traceState,
    agentName,
    latestScreenshot,
    isCapturing,
    isStartingTrace,
    isStoppingTrace,
    handleSelectTab,
    handleCloseTab,
    handleReconnect,
    handleCaptureScreenshot,
    handleStartTrace,
    handleStopTrace,
  } = useBrowserObservation(agentId)

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      {/* Breadcrumb: Agents > [Agent Name] > Browser */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
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

        {/* Screenshot button */}
        <ScreenshotButton
          onCapture={() => void handleCaptureScreenshot()}
          isCapturing={isCapturing}
        />
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

        {/* Right sidebar: trace controls + timeline */}
        <div className="w-[360px] shrink-0">
          <div className="sticky top-6 flex flex-col gap-4">
            {/* Trace controls */}
            <TraceControls
              traceStatus={traceState.status}
              startedAt={traceState.startedAt}
              onStartTrace={() => void handleStartTrace()}
              onStopTrace={() => void handleStopTrace()}
              isStarting={isStartingTrace}
              isStopping={isStoppingTrace}
            />

            {/* Trace events timeline */}
            <div>
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
            <TabBar tabs={tabs} onSelectTab={handleSelectTab} onCloseTab={handleCloseTab} />
          </div>
        )}
        {mobileTab === "Screenshots" && <ScreenshotGallery screenshots={screenshots} />}
        {mobileTab === "Trace" && (
          <div className="flex flex-col gap-4">
            <TraceControls
              traceStatus={traceState.status}
              startedAt={traceState.startedAt}
              onStartTrace={() => void handleStartTrace()}
              onStopTrace={() => void handleStopTrace()}
              isStarting={isStartingTrace}
              isStopping={isStoppingTrace}
            />
            <TraceTimeline events={events} />
          </div>
        )}
      </div>
    </div>
  )
}
