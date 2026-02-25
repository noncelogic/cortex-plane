'use client'

import { useMemo } from "react"

import { z } from "zod"

import type { SSEConnectionStatus } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

const JobStreamEventSchema = z.object({
  jobId: z.string(),
  status: z.string().optional(),
  timestamp: z.string().optional(),
  error: z.string().optional(),
})

export type JobStreamEvent = z.infer<typeof JobStreamEventSchema>

export interface ParsedJobEvent {
  type: string
  data: JobStreamEvent
}

interface UseJobStreamReturn {
  events: ParsedJobEvent[]
  connected: boolean
  status: SSEConnectionStatus
}

export function useJobStream(options?: { maxEvents?: number }): UseJobStreamReturn {
  const {
    events: rawEvents,
    connected,
    status,
  } = useSSE({
    url: "/api/jobs/stream",
    eventTypes: ["job:created", "job:updated", "job:completed", "job:failed"],
    maxEvents: options?.maxEvents ?? 500,
  })

  const events = useMemo(
    () =>
      rawEvents.reduce<ParsedJobEvent[]>((acc, e) => {
        try {
          const raw: unknown = JSON.parse(e.data)
          const data = JobStreamEventSchema.parse(raw)
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
