"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useApi, useApiQuery } from "@/hooks/use-api"
import type {
  ApiErrorCode,
  BrowserEvent,
  BrowserSession,
  BrowserTab,
  Screenshot,
  TraceState,
} from "@/lib/api-client"
import {
  captureScreenshot,
  getAgent,
  getAgentBrowser,
  getAgentBrowserEvents,
  getAgentScreenshots,
  getTraceState,
  startTrace,
  stopTrace,
} from "@/lib/api-client"

const AUTO_REFRESH_INTERVAL_MS = 5_000

export function useBrowserObservation(agentId: string) {
  const [tabs, setTabs] = useState<BrowserTab[]>([])

  // -------------------------------------------------------------------------
  // Queries (auto-fetch on mount)
  // -------------------------------------------------------------------------

  const {
    data: agentData,
    isLoading: agentLoading,
    error: agentError,
    errorCode: agentErrorCode,
    refetch: refetchAgent,
  } = useApiQuery(() => getAgent(agentId), [agentId])
  const {
    data: sessionData,
    isLoading: sessionLoading,
    error: sessionError,
    errorCode: sessionErrorCode,
    refetch: refetchSession,
  } = useApiQuery(() => getAgentBrowser(agentId), [agentId])
  const {
    data: screenshotData,
    isLoading: screenshotLoading,
    error: screenshotError,
    errorCode: screenshotErrorCode,
    refetch: refetchScreenshots,
  } = useApiQuery(() => getAgentScreenshots(agentId), [agentId])
  const {
    data: eventData,
    isLoading: eventLoading,
    error: eventError,
    errorCode: eventErrorCode,
    refetch: refetchEvents,
  } = useApiQuery(() => getAgentBrowserEvents(agentId), [agentId])
  const { data: traceData, refetch: refetchTrace } = useApiQuery(
    () => getTraceState(agentId),
    [agentId],
  )

  // -------------------------------------------------------------------------
  // Actions (manual trigger)
  // -------------------------------------------------------------------------

  const { execute: execCapture, isLoading: isCapturing } = useApi(() => captureScreenshot(agentId))
  const { execute: execStartTrace, isLoading: isStartingTrace } = useApi(() => startTrace(agentId))
  const { execute: execStopTrace, isLoading: isStoppingTrace } = useApi(() => stopTrace(agentId))

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  useEffect(() => {
    setTabs(sessionData?.tabs ?? [])
  }, [sessionData])

  const session: BrowserSession = useMemo(() => {
    return (
      sessionData ?? {
        id: `session-${agentId}`,
        agent_id: agentId,
        vnc_url: null,
        status: sessionError ? "error" : "connecting",
        tabs: [],
        latency_ms: 0,
      }
    )
  }, [sessionData, sessionError, agentId])

  const screenshots: Screenshot[] = useMemo(() => {
    return screenshotData?.screenshots ?? []
  }, [screenshotData])

  const events: BrowserEvent[] = useMemo(() => {
    return eventData?.events ?? []
  }, [eventData])

  const traceState: TraceState = useMemo(() => {
    return traceData ?? { status: "idle" as const }
  }, [traceData])

  const agentName = agentData?.name ?? `Agent ${agentId.slice(0, 8)}`
  const isLoading = agentLoading || sessionLoading || screenshotLoading || eventLoading
  const error = agentError || sessionError || screenshotError || eventError
  const errorCode: ApiErrorCode | null =
    agentErrorCode || sessionErrorCode || screenshotErrorCode || eventErrorCode || null

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSelectTab = (tabId: string) => {
    setTabs((prev) => prev.map((t) => ({ ...t, active: t.id === tabId })))
  }

  const handleCloseTab = (tabId: string) => {
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId)
      if (filtered.length > 0 && !filtered.some((t) => t.active)) {
        filtered[0] = { ...filtered[0]!, active: true }
      }
      return filtered
    })
  }

  const handleReconnect = () => {
    void refetchAgent()
    void refetchSession()
    void refetchScreenshots()
    void refetchEvents()
    void refetchTrace()
  }

  const handleCaptureScreenshot = useCallback(async () => {
    await execCapture()
    void refetchScreenshots()
  }, [execCapture, refetchScreenshots])

  const handleStartTrace = useCallback(async () => {
    await execStartTrace()
    void refetchTrace()
  }, [execStartTrace, refetchTrace])

  const handleStopTrace = useCallback(async () => {
    await execStopTrace()
    void refetchTrace()
  }, [execStopTrace, refetchTrace])

  // -------------------------------------------------------------------------
  // Auto-refresh: periodically refetch screenshots + events when VNC is
  // unavailable so the "live view" stays current.
  // -------------------------------------------------------------------------

  const sessionRef = useRef(session)
  sessionRef.current = session

  useEffect(() => {
    // Only auto-refresh when there is no VNC and the session is not in error
    if (session.vnc_url) return
    if (session.status === "error") return

    const id = setInterval(() => {
      void refetchScreenshots()
      void refetchEvents()
    }, AUTO_REFRESH_INTERVAL_MS)

    return () => clearInterval(id)
  }, [session.vnc_url, session.status, refetchScreenshots, refetchEvents])

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  const latestScreenshot = screenshots.length > 0 ? screenshots[0]! : null

  return {
    session,
    tabs,
    screenshots,
    events,
    traceState,
    agentName,
    latestScreenshot,
    isLoading,
    isCapturing,
    isStartingTrace,
    isStoppingTrace,
    error,
    errorCode,
    handleSelectTab,
    handleCloseTab,
    handleReconnect,
    handleCaptureScreenshot,
    handleStartTrace,
    handleStopTrace,
  }
}
