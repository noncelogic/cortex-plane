'use client'

import { useMemo, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { BrowserEvent, BrowserSession, BrowserTab, Screenshot } from "@/lib/api-client"
import { getAgent, getAgentBrowser, getAgentBrowserEvents, getAgentScreenshots } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import { mockBrowserEvents, mockBrowserSession, mockScreenshots, mockTabs } from "@/lib/mock/browser"

export function useBrowserObservation(agentId: string) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => mockTabs())

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

  const session: BrowserSession = sessionData ?? (sessionError || isMockEnabled() ? mockBrowserSession(agentId) : mockBrowserSession(agentId))
  const screenshots: Screenshot[] = useMemo(
    () => screenshotData?.screenshots ?? (screenshotError || isMockEnabled() ? mockScreenshots(agentId) : mockScreenshots(agentId)),
    [screenshotData, screenshotError, agentId],
  )
  const events: BrowserEvent[] = useMemo(
    () => eventData?.events ?? (eventError || isMockEnabled() ? mockBrowserEvents() : mockBrowserEvents()),
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
