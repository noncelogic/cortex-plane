"use client"

import { useCallback, useState } from "react"

import type { BrowserSessionStatus, Screenshot } from "@/lib/api-client"

import { ConnectionStatus } from "./connection-status"

interface BrowserViewportProps {
  vncUrl: string | null
  status: BrowserSessionStatus
  latencyMs?: number
  latestScreenshot?: Screenshot | null
  onReconnect?: () => void
}

export function BrowserViewport({
  vncUrl,
  status,
  latencyMs,
  latestScreenshot,
  onReconnect,
}: BrowserViewportProps): React.JSX.Element {
  const [isFullscreen, setIsFullscreen] = useState(false)

  const handleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const handleRefresh = useCallback(() => {
    // In a real implementation, this would reload the VNC iframe
    onReconnect?.()
  }, [onReconnect])

  const canShowVnc = vncUrl && (status === "connected" || status === "connecting")

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl border border-chrome-border bg-black ${
        isFullscreen ? "fixed inset-0 z-50" : "relative"
      }`}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-chrome-border bg-chrome-bg px-3 py-2">
        <ConnectionStatus status={status} latencyMs={latencyMs} onReconnect={onReconnect} />

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
          <button
            type="button"
            onClick={handleFullscreen}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            <span className="material-symbols-outlined text-sm">
              {isFullscreen ? "fullscreen_exit" : "fullscreen"}
            </span>
          </button>
        </div>
      </div>

      {/* Viewport area */}
      <div className="relative aspect-video w-full overflow-auto bg-chrome-deep">
        {canShowVnc ? (
          <>
            <iframe
              src={vncUrl}
              title="Browser Session"
              className="size-full border-0"
              sandbox="allow-scripts allow-same-origin"
            />
            {status === "connecting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                <div className="flex flex-col items-center gap-3">
                  <span className="material-symbols-outlined animate-spin text-3xl text-primary">
                    sync
                  </span>
                  <span className="text-sm text-slate-400">Connecting to browser session...</span>
                </div>
              </div>
            )}
          </>
        ) : latestScreenshot ? (
          <ScreenshotFallback screenshot={latestScreenshot} />
        ) : (
          <ViewportPlaceholder status={status} onReconnect={onReconnect} />
        )}
      </div>

      {/* Fullscreen close hint */}
      {isFullscreen && (
        <div className="absolute right-4 top-14 z-10">
          <button
            type="button"
            onClick={handleFullscreen}
            className="rounded-lg bg-slate-800/80 px-3 py-1.5 text-xs text-slate-300 backdrop-blur transition-colors hover:bg-slate-700/80"
          >
            Press Esc or click to exit fullscreen
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScreenshotFallback({ screenshot }: { screenshot: Screenshot }): React.JSX.Element {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-4">
      <div className="relative overflow-hidden rounded-lg border border-chrome-border">
        <img
          src={screenshot.fullUrl}
          alt={`Screenshot from ${new Date(screenshot.timestamp).toLocaleTimeString()}`}
          className="max-h-[60vh] w-auto object-contain"
        />
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2">
          <span className="text-xs text-slate-300">
            Latest screenshot &middot;{" "}
            {new Date(screenshot.timestamp).toLocaleTimeString("en-US", { hour12: false })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="material-symbols-outlined text-sm">info</span>
        VNC unavailable — showing latest screenshot
      </div>
    </div>
  )
}

function ViewportPlaceholder({
  status,
  onReconnect,
}: {
  status: BrowserSessionStatus
  onReconnect?: () => void
}): React.JSX.Element {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-4 p-8">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-chrome-bg">
        <span className="material-symbols-outlined text-3xl text-slate-600">
          {status === "error" ? "error" : "desktop_windows"}
        </span>
      </div>
      <div className="text-center">
        <p className="text-sm font-bold text-slate-300">
          {status === "error" ? "Connection Error" : "No Active Browser Session"}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {status === "error"
            ? "Failed to connect to the browser session"
            : "Waiting for agent to start a browser session"}
        </p>
      </div>
      {status === "error" && onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="flex items-center gap-2 rounded-lg bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/20"
        >
          <span className="material-symbols-outlined text-lg">refresh</span>
          Try Reconnecting
        </button>
      )}
    </div>
  )
}
