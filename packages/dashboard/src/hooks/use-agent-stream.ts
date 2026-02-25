"use client"

import { useMemo } from "react"

import type { SSEEvent } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

interface AgentEvent {
  type: string
  data: string
}

interface UseAgentStreamReturn {
  events: AgentEvent[]
  connected: boolean
}

export function useAgentStream(agentId: string): UseAgentStreamReturn {
  const url = `/api/agents/${agentId}/stream`

  const { events: rawEvents, connected } = useSSE({
    url,
    eventTypes: ["agent:output", "agent:state", "agent:error", "agent:complete", "steer:ack"],
  })

  const events = useMemo(
    () => rawEvents.map((e: SSEEvent) => ({ type: e.type, data: e.data })),
    [rawEvents],
  )

  return { events, connected }
}
