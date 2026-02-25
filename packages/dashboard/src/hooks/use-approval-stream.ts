"use client"

import { useMemo } from "react"

import { useSSE } from "./use-sse"

interface ApprovalEvent {
  type: "created" | "decided" | "expired"
  data: Record<string, unknown>
}

interface UseApprovalStreamReturn {
  events: ApprovalEvent[]
  pendingCount: number
  connected: boolean
}

export function useApprovalStream(): UseApprovalStreamReturn {
  const { events: rawEvents, connected } = useSSE({
    url: "/api/approvals/stream",
    eventTypes: ["approval:created", "approval:decided", "approval:expired"],
  })

  const events = useMemo(
    () =>
      rawEvents.map((e) => ({
        type: e.type.replace("approval:", "") as ApprovalEvent["type"],
        data: JSON.parse(e.data) as Record<string, unknown>,
      })),
    [rawEvents],
  )

  // Simple pending count: +1 for created, -1 for decided/expired
  const pendingCount = useMemo(
    () =>
      events.reduce((count, e) => {
        if (e.type === "created") return count + 1
        return Math.max(0, count - 1)
      }, 0),
    [events],
  )

  return { events, pendingCount, connected }
}
