"use client"

import { useMemo } from "react"
import { z } from "zod"

import { resolveSSEUrl, type SSEConnectionStatus, type SSEEvent } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

// ---------------------------------------------------------------------------
// Payload schema — the activity stream sends `agent:output` events whose
// `output` field contains the structured event data.
// ---------------------------------------------------------------------------

const ActivityEventSchema = z.object({
  agentId: z.string(),
  timestamp: z.string(),
  output: z
    .object({
      type: z.string(),
      eventType: z.string(),
    })
    .passthrough(),
})

export interface ActivityEvent {
  agentId: string
  timestamp: string
  eventType: string
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseActivityStreamOptions {
  /** Comma-separated agent IDs to filter */
  agentIds?: string
  /** Comma-separated event types to filter */
  eventTypes?: string
  /** Timestamp ISO string to replay events since */
  since?: string
  /** Max events in buffer (default: 500) */
  maxEvents?: number
  /** Auto-connect (default: true) */
  autoConnect?: boolean
}

interface UseActivityStreamReturn {
  events: ActivityEvent[]
  rawEvents: SSEEvent[]
  connected: boolean
  status: SSEConnectionStatus
  connect: () => void
  disconnect: () => void
}

export function useActivityStream(options?: UseActivityStreamOptions): UseActivityStreamReturn {
  const params = new URLSearchParams()
  if (options?.agentIds) params.set("agentIds", options.agentIds)
  if (options?.eventTypes) params.set("eventTypes", options.eventTypes)
  if (options?.since) params.set("since", options.since)
  const qs = params.toString()
  const url = resolveSSEUrl(`/api/operators/activity-stream${qs ? `?${qs}` : ""}`)

  const {
    events: rawEvents,
    connected,
    status,
    connect,
    disconnect,
  } = useSSE({
    url,
    eventTypes: ["agent:output"],
    maxEvents: options?.maxEvents ?? 500,
    autoConnect: options?.autoConnect ?? true,
  })

  const events = useMemo(
    () =>
      rawEvents.reduce<ActivityEvent[]>((acc, e: SSEEvent) => {
        try {
          const raw: unknown = JSON.parse(e.data)
          const parsed = ActivityEventSchema.parse(raw)
          acc.push({
            agentId: parsed.agentId,
            timestamp: parsed.timestamp,
            eventType: parsed.output.eventType,
            payload: parsed.output as Record<string, unknown>,
          })
        } catch {
          // skip malformed events
        }
        return acc
      }, []),
    [rawEvents],
  )

  return { events, rawEvents, connected, status, connect, disconnect }
}
