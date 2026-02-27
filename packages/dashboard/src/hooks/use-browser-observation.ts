"use client"

import { useEffect, useMemo, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type {
  ApiErrorCode,
  BrowserEvent,
  BrowserSession,
  BrowserTab,
  Screenshot,
} from "@/lib/api-client"
import {
  getAgent,
  getAgentBrowser,
  getAgentBrowserEvents,
  getAgentScreenshots,
} from "@/lib/api-client"

export function useBrowserObservation(agentId: string) {
  const [tabs, setTabs] = useState<BrowserTab[]>([])

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

  useEffect(() => {
    setTabs(sessionData?.tabs ?? [])
  }, [sessionData])

  const session: BrowserSession = useMemo(() => {
    return (
      sessionData ?? {
        id: `session-${agentId}`,
        agentId,
        vncUrl: null,
        status: sessionError ? "error" : "connecting",
        tabs: [],
        latencyMs: 0,
      }
    )
  }, [sessionData, sessionError, agentId])

  const screenshots: Screenshot[] = useMemo(() => {
    return screenshotData?.screenshots ?? []
  }, [screenshotData])

  const events: BrowserEvent[] = useMemo(() => {
    return eventData?.events ?? []
  }, [eventData])

  const agentName = agentData?.name ?? `Agent ${agentId.slice(0, 8)}`
  const isLoading = agentLoading || sessionLoading || screenshotLoading || eventLoading
  const error = agentError || sessionError || screenshotError || eventError
  const errorCode: ApiErrorCode | null =
    agentErrorCode || sessionErrorCode || screenshotErrorCode || eventErrorCode || null

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
  }

  const latestScreenshot = screenshots.length > 0 ? screenshots[0]! : null

  return {
    session,
    tabs,
    screenshots,
    events,
    agentName,
    latestScreenshot,
    isLoading,
    error,
    errorCode,
    handleSelectTab,
    handleCloseTab,
    handleReconnect,
  }
}
