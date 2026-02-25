'use client'

import { useMemo } from "react"

import { z } from "zod"

import type { SSEConnectionStatus } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

const ContentStreamEventSchema = z.object({
  contentId: z.string(),
  status: z.string().optional(),
  title: z.string().optional(),
  timestamp: z.string().optional(),
  channel: z.string().optional(),
})

export type ContentStreamEvent = z.infer<typeof ContentStreamEventSchema>

export interface ParsedContentEvent {
  type: string
  data: ContentStreamEvent
}

interface UseContentStreamReturn {
  events: ParsedContentEvent[]
  connected: boolean
  status: SSEConnectionStatus
}

export function useContentStream(options?: { maxEvents?: number }): UseContentStreamReturn {
  const {
    events: rawEvents,
    connected,
    status,
  } = useSSE({
    url: "/api/content/stream",
    eventTypes: ["content:created", "content:updated", "content:published", "content:archived"],
    maxEvents: options?.maxEvents ?? 500,
  })

  const events = useMemo(
    () =>
      rawEvents.reduce<ParsedContentEvent[]>((acc, e) => {
        try {
          const raw: unknown = JSON.parse(e.data)
          const data = ContentStreamEventSchema.parse(raw)
          acc.push({ type: e.type, data })
        } catch {
          // skip events that fail Zod validation
        }
        return acc
      }, []),
    [rawEvents],
  )

  return { events, connected, status }
}
