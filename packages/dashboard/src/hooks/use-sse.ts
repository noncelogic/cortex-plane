"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { SSEClient, type SSEConnectionStatus, type SSEEvent } from "@/lib/sse-client"

interface UseSSEOptions {
  /** SSE endpoint URL */
  url: string
  /** Event types to subscribe to (default: ["*"]) */
  eventTypes?: string[]
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
  /** Max events to keep in buffer (default: 500) */
  maxEvents?: number
}

interface UseSSEReturn {
  /** Buffered events (most recent last) */
  events: SSEEvent[]
  /** Convenience alias — true when status is "connected" */
  connected: boolean
  /** Tri-state: connecting | connected | disconnected */
  status: SSEConnectionStatus
  /** Last error message, if any */
  error: string | null
  /** Manually open the connection */
  connect: () => void
  /** Manually close the connection */
  disconnect: () => void
}

export function useSSE({
  url,
  eventTypes = ["*"],
  autoConnect = true,
  maxEvents = 500,
}: UseSSEOptions): UseSSEReturn {
  const [events, setEvents] = useState<SSEEvent[]>([])
  const [status, setStatus] = useState<SSEConnectionStatus>("disconnected")
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<SSEClient | null>(null)
  // Track whether we were connected before the tab was hidden
  const wasConnectedRef = useRef(false)

  const connect = useCallback(() => {
    setError(null)
    clientRef.current?.connect()
  }, [])

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect()
  }, [])

  useEffect(() => {
    const client = new SSEClient(url)
    clientRef.current = client

    const unsubs: Array<() => void> = []

    unsubs.push(
      client.onStatus((s) => {
        setStatus(s)
        if (s === "disconnected" && client.status === "disconnected") {
          // Only set error when we lose a previously-open connection
          // (the backoff will auto-reconnect, so this is informational)
        }
      }),
    )

    for (const type of eventTypes) {
      unsubs.push(
        client.on(type, (event) => {
          setEvents((prev) => [...prev.slice(-(maxEvents - 1)), event])
        }),
      )
    }

    // Page Visibility API: pause SSE when tab is hidden to save resources
    function handleVisibilityChange(): void {
      if (document.hidden) {
        if (client.status === "connected" || client.status === "connecting") {
          wasConnectedRef.current = true
          client.disconnect()
        }
      } else {
        if (wasConnectedRef.current) {
          wasConnectedRef.current = false
          client.connect()
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)

    if (autoConnect) {
      client.connect()
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      unsubs.forEach((u) => u())
      client.disconnect()
    }
  }, [url, autoConnect, maxEvents])

  return {
    events,
    connected: status === "connected",
    status,
    error,
    connect,
    disconnect,
  }
}
