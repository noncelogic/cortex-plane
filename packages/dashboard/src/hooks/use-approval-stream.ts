"use client"

import { useMemo } from "react"

import type { SSEConnectionStatus, SSEEvent } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

// ---------------------------------------------------------------------------
// Typed payloads (mirrors control-plane streaming/types.ts)
// ---------------------------------------------------------------------------

export interface ApprovalCreatedPayload {
  approvalRequestId: string
  jobId: string
  agentId: string
  actionSummary: string
  actionType: string
  expiresAt: string
  timestamp: string
}

export interface ApprovalDecidedPayload {
  approvalRequestId: string
  jobId: string
  decision: string
  decidedBy: string
  timestamp: string
}

export interface ApprovalExpiredPayload {
  approvalRequestId: string
  jobId: string
  expiredAt: string
  timestamp: string
}

export type ApprovalEventPayload =
  | { type: "created"; data: ApprovalCreatedPayload }
  | { type: "decided"; data: ApprovalDecidedPayload }
  | { type: "expired"; data: ApprovalExpiredPayload }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseApprovalStreamReturn {
  /** Typed, parsed approval events */
  events: ApprovalEventPayload[]
  /** Running count of pending approvals derived from the stream */
  pendingCount: number
  /** Whether the stream is connected */
  connected: boolean
  /** Tri-state connection status */
  status: SSEConnectionStatus
}

export function useApprovalStream(): UseApprovalStreamReturn {
  const {
    events: rawEvents,
    connected,
    status,
  } = useSSE({
    url: "/api/approvals/stream",
    eventTypes: ["approval:created", "approval:decided", "approval:expired"],
  })

  const events = useMemo(
    () =>
      rawEvents.reduce<ApprovalEventPayload[]>((acc, e: SSEEvent) => {
        try {
          const shortType = e.type.replace("approval:", "") as ApprovalEventPayload["type"]
          const data: unknown = JSON.parse(e.data)
          acc.push({ type: shortType, data } as unknown as ApprovalEventPayload)
        } catch {
          // skip events with unparseable data
        }
        return acc
      }, []),
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

  return { events, pendingCount, connected, status }
}
