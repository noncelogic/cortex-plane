'use client'

import { useMemo, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { BrowserEvent, BrowserSession, BrowserTab, Screenshot } from "@/lib/api-client"
import { getAgent, getAgentBrowser, getAgentBrowserEvents, getAgentScreenshots } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import { mockBrowserEvents, mockBrowserSession, mockScreenshots, mockTabs } from "@/lib/mock/browser"

export function useBrowserObservation(agentId: string) {
  const mock = isMockEnabled()
  const [tabs, setTabs] = useState<BrowserTab[]>(() => mock ? mockTabs() : [])

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

  const session: BrowserSession = useMemo(() => {
    if (mock) return mockBrowserSession(agentId)
    return sessionData ?? {
      id: `session-${agentId}`,
      agentId,
      vncUrl: null,
      status: sessionError ? "error" : "connecting",
      tabs: [],
      latencyMs: 0,
    }
  }, [sessionData, sessionError, agentId, mock])

  const screenshots: Screenshot[] = useMemo(() => {
    if (mock) return mockScreenshots(agentId)
    return screenshotData?.screenshots ?? []
  }, [screenshotData, agentId, mock])

  const events: BrowserEvent[] = useMemo(() => {
    if (mock) return mockBrowserEvents()
    return eventData?.events ?? []
  }, [eventData, mock])

  const agentName = agentData?.name ?? `Agent ${agentId.slice(0, 8)}`

  const handleSelectTab = (tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => ({ ...t, active: t.id === tabId })),
    )
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
    // In production this would re-establish the VNC connection
  }

  const latestScreenshot = screenshots.length > 0 ? screenshots[0]! : null

  return {
    session,
    tabs,
    screenshots,
    events,
    agentName,
    latestScreenshot,
    handleSelectTab,
    handleCloseTab,
    handleReconnect,
  }
}
