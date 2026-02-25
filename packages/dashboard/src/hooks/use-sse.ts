"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { SSEClient, type SSEEvent } from "@/lib/sse-client"

interface UseSSEOptions {
  /** SSE endpoint URL */
  url: string
  /** Event types to subscribe to (default: ["*"]) */
  eventTypes?: string[]
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
}

interface UseSSEReturn {
  events: SSEEvent[]
  connected: boolean
  connect: () => void
  disconnect: () => void
}

export function useSSE({
  url,
  eventTypes = ["*"],
  autoConnect = true,
}: UseSSEOptions): UseSSEReturn {
  const [events, setEvents] = useState<SSEEvent[]>([])
  const [connected, setConnected] = useState(false)
  const clientRef = useRef<SSEClient | null>(null)

  const connect = useCallback(() => {
    clientRef.current?.connect()
  }, [])

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect()
  }, [])

  useEffect(() => {
    const client = new SSEClient(url)
    clientRef.current = client

    const unsubs: Array<() => void> = []

    unsubs.push(client.onConnection(setConnected))

    for (const type of eventTypes) {
      unsubs.push(
        client.on(type, (event) => {
          setEvents((prev) => [...prev.slice(-500), event]) // keep last 500
        }),
      )
    }

    if (autoConnect) {
      client.connect()
    }

    return () => {
      unsubs.forEach((u) => u())
      client.disconnect()
    }
  }, [url, autoConnect])

  return { events, connected, connect, disconnect }
}
