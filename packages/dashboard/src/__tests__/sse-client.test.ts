import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SSEClient, type SSEConnectionStatus, type SSEEvent } from "@/lib/sse-client"

// ---------------------------------------------------------------------------
// Minimal EventSource mock
// ---------------------------------------------------------------------------

type EventSourceListener = (e: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  readyState = 0 // CONNECTING

  private listeners = new Map<string, Set<EventSourceListener>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  close(): void {
    this.readyState = 2 // CLOSED
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }

  simulateError(): void {
    this.onerror?.()
  }

  simulateMessage(data: string, lastEventId?: string, type?: string): void {
    const event = new MessageEvent(type ?? "message", {
      data,
      lastEventId: lastEventId ?? "",
    })
    if (type && this.listeners.has(type)) {
      this.listeners.get(type)!.forEach((fn) => fn(event))
    } else {
      this.onmessage?.(event)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSEClient", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockEventSource.instances = []
    vi.stubGlobal("EventSource", MockEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("connects to the provided URL", () => {
    const client = new SSEClient("/stream")
    client.connect()

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0]!.url).toBe("/stream")
  })

  it("tracks connection status through lifecycle", () => {
    const client = new SSEClient("/stream")
    const statuses: SSEConnectionStatus[] = []
    client.onStatus((s) => statuses.push(s))

    expect(client.status).toBe("disconnected")

    client.connect()
    expect(statuses).toContain("connecting")

    MockEventSource.instances[0]!.simulateOpen()
    expect(statuses).toContain("connected")
    expect(client.status).toBe("connected")

    client.disconnect()
    expect(statuses[statuses.length - 1]).toBe("disconnected")
    expect(client.status).toBe("disconnected")
  })

  it("dispatches events to type-specific handlers", () => {
    const client = new SSEClient("/stream")
    const received: SSEEvent[] = []
    client.on("agent:output", (e) => received.push(e))

    client.connect()
    const es = MockEventSource.instances[0]!
    es.simulateOpen()
    es.simulateMessage('{"text":"hello"}', "1", "agent:output")

    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe("agent:output")
    expect(received[0]!.data).toBe('{"text":"hello"}')
    expect(received[0]!.id).toBe("1")
  })

  it("dispatches events to wildcard handlers", () => {
    const client = new SSEClient("/stream")
    const received: SSEEvent[] = []
    client.on("*", (e) => received.push(e))

    client.connect()
    const es = MockEventSource.instances[0]!
    es.simulateOpen()
    es.simulateMessage('{"text":"hello"}', "1", "agent:output")
    es.simulateMessage('{"state":"READY"}', "2", "agent:state")

    expect(received).toHaveLength(2)
  })

  it("tracks last event ID for reconnection", () => {
    const client = new SSEClient("/stream")
    client.on("*", () => {})

    client.connect()
    const es = MockEventSource.instances[0]!
    es.simulateOpen()
    es.simulateMessage("data", "event-42")

    // Disconnect and reconnect
    client.disconnect()
    client.connect()

    const reconnectUrl = MockEventSource.instances[1]!.url
    expect(reconnectUrl).toBe("/stream?lastEventId=event-42")
  })

  it("appends lastEventId with & when URL has query params", () => {
    const client = new SSEClient("/stream?token=abc")
    client.on("*", () => {})

    client.connect()
    MockEventSource.instances[0]!.simulateOpen()
    MockEventSource.instances[0]!.simulateMessage("data", "5")

    client.disconnect()
    client.connect()

    expect(MockEventSource.instances[1]!.url).toBe("/stream?token=abc&lastEventId=5")
  })

  describe("exponential backoff", () => {
    it("reconnects after error with backoff", () => {
      const client = new SSEClient("/stream")
      client.connect()

      const es = MockEventSource.instances[0]!
      es.simulateOpen()
      es.simulateError()

      // Should not have reconnected yet
      expect(MockEventSource.instances).toHaveLength(1)

      // Advance past initial backoff (1s + jitter)
      vi.advanceTimersByTime(2_000)

      // Should have attempted reconnection
      expect(MockEventSource.instances).toHaveLength(2)
    })

    it("increases delay on consecutive errors", () => {
      const client = new SSEClient("/stream")
      client.connect()

      // First error
      MockEventSource.instances[0]!.simulateError()
      vi.advanceTimersByTime(2_000) // past 1s + jitter
      expect(MockEventSource.instances).toHaveLength(2)

      // Second error (backoff should be ~2s now)
      MockEventSource.instances[1]!.simulateError()
      vi.advanceTimersByTime(1_500)
      // Should NOT have reconnected yet (backoff is ~2s+jitter)
      expect(MockEventSource.instances).toHaveLength(2)
      vi.advanceTimersByTime(2_000) // total 3.5s, past 2s+jitter
      expect(MockEventSource.instances).toHaveLength(3)
    })

    it("resets backoff on successful connection", () => {
      const client = new SSEClient("/stream")
      client.connect()

      // Trigger a few errors to increase backoff
      MockEventSource.instances[0]!.simulateError()
      vi.advanceTimersByTime(2_000)
      MockEventSource.instances[1]!.simulateError()
      vi.advanceTimersByTime(4_000)

      // This time, successfully connect
      MockEventSource.instances[2]!.simulateOpen()

      // Disconnect and trigger error again — backoff should be reset
      MockEventSource.instances[2]!.simulateError()
      vi.advanceTimersByTime(2_000) // past 1s + jitter (reset backoff)
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(4)
    })

    it("does not reconnect after explicit disconnect", () => {
      const client = new SSEClient("/stream")
      client.connect()
      MockEventSource.instances[0]!.simulateOpen()

      client.disconnect()
      vi.advanceTimersByTime(60_000)

      // Only the initial connection should exist
      expect(MockEventSource.instances).toHaveLength(1)
    })
  })

  it("removes handler on unsubscribe", () => {
    const client = new SSEClient("/stream")
    const received: SSEEvent[] = []
    const unsub = client.on("*", (e) => received.push(e))

    client.connect()
    const es = MockEventSource.instances[0]!
    es.simulateOpen()
    es.simulateMessage("first", "1")
    unsub()
    es.simulateMessage("second", "2")

    expect(received).toHaveLength(1)
  })

  it("provides backward-compat onConnection method", () => {
    const client = new SSEClient("/stream")
    const values: boolean[] = []
    client.onConnection((connected) => values.push(connected))

    client.connect()
    MockEventSource.instances[0]!.simulateOpen()
    client.disconnect()

    expect(values).toEqual([false, true, false])
  })

  it("prevents double connect", () => {
    const client = new SSEClient("/stream")
    client.connect()
    client.connect()
    expect(MockEventSource.instances).toHaveLength(1)
  })
})
