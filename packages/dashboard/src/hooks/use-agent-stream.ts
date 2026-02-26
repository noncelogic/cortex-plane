"use client"

import { useMemo } from "react"

import { resolveSSEUrl, type SSEConnectionStatus, type SSEEvent } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

// ---------------------------------------------------------------------------
// Typed payloads (mirrors control-plane streaming/types.ts)
// ---------------------------------------------------------------------------

export interface AgentOutputPayload {
  agentId: string
  timestamp: string
  output: { type: string; content: string; [key: string]: unknown }
}

export interface AgentStatePayload {
  agentId: string
  timestamp: string
  state: string
  reason?: string
}

export interface AgentErrorPayload {
  agentId: string
  timestamp: string
  message: string
  code?: string
}

export interface AgentCompletePayload {
  agentId: string
  timestamp: string
  summary?: string
}

export interface SteerAckPayload {
  agentId: string
  steerMessageId: string
  timestamp: string
  status: "accepted" | "rejected"
  reason?: string
}

export type AgentEventPayload =
  | { type: "agent:output"; data: AgentOutputPayload }
  | { type: "agent:state"; data: AgentStatePayload }
  | { type: "agent:error"; data: AgentErrorPayload }
  | { type: "agent:complete"; data: AgentCompletePayload }
  | { type: "steer:ack"; data: SteerAckPayload }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const AGENT_EVENT_TYPES = [
  "agent:output",
  "agent:state",
  "agent:error",
  "agent:complete",
  "steer:ack",
] as const

interface UseAgentStreamOptions {
  /** Max events to keep in the replay buffer (default: 500) */
  maxEvents?: number
}

interface UseAgentStreamReturn {
  /** Typed, parsed events (most recent last) */
  events: AgentEventPayload[]
  /** Raw SSE events for low-level access */
  rawEvents: SSEEvent[]
  /** Whether the stream is connected */
  connected: boolean
  /** Tri-state connection status */
  status: SSEConnectionStatus
}

export function useAgentStream(
  agentId: string,
  options?: UseAgentStreamOptions,
): UseAgentStreamReturn {
  const url = resolveSSEUrl(`/api/agents/${agentId}/stream`)

  const {
    events: rawEvents,
    connected,
    status,
  } = useSSE({
    url,
    eventTypes: [...AGENT_EVENT_TYPES],
    maxEvents: options?.maxEvents ?? 500,
  })

  const events = useMemo(
    () =>
      rawEvents.reduce<AgentEventPayload[]>((acc, e: SSEEvent) => {
        try {
          const data: unknown = JSON.parse(e.data)
          acc.push({ type: e.type, data } as unknown as AgentEventPayload)
        } catch {
          // skip events with unparseable data
        }
        return acc
      }, []),
    [rawEvents],
  )

  return { events, rawEvents, connected, status }
}
