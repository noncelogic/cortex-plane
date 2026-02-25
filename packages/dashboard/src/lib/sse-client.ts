/**
 * EventSource wrapper with Last-Event-ID reconnection support.
 *
 * Native EventSource doesn't support custom headers, so for authenticated
 * SSE we proxy through Next.js API routes. This wrapper handles:
 * - Automatic reconnection with Last-Event-ID
 * - Event parsing and typed dispatch
 * - Connection state tracking
 */

export interface SSEEvent {
  id: string
  type: string
  data: string
}

export type SSEEventHandler = (event: SSEEvent) => void
type ConnectionStateHandler = (connected: boolean) => void

export class SSEClient {
  private eventSource: EventSource | null = null
  private lastEventId: string | null = null
  private handlers = new Map<string, Set<SSEEventHandler>>()
  private connectionHandlers = new Set<ConnectionStateHandler>()
  private url: string

  constructor(url: string) {
    this.url = url
  }

  connect(): void {
    if (this.eventSource) return

    const connectUrl = this.lastEventId
      ? `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${this.lastEventId}`
      : this.url

    this.eventSource = new EventSource(connectUrl)

    this.eventSource.onopen = () => {
      this.connectionHandlers.forEach((h) => h(true))
    }

    this.eventSource.onerror = () => {
      this.connectionHandlers.forEach((h) => h(false))
      // EventSource auto-reconnects; we just track the state
    }

    this.eventSource.onmessage = (e) => {
      this.dispatch(e)
    }

    // Register named event listeners for all known types
    const eventTypes = [
      "agent:state",
      "agent:output",
      "agent:error",
      "agent:complete",
      "steer:ack",
      "approval:created",
      "approval:decided",
      "approval:expired",
      "browser:screenshot",
      "browser:trace:state",
      "browser:annotation:ack",
    ]

    for (const type of eventTypes) {
      this.eventSource.addEventListener(type, (e) => this.dispatch(e))
    }
  }

  disconnect(): void {
    this.eventSource?.close()
    this.eventSource = null
    this.connectionHandlers.forEach((h) => h(false))
  }

  on(eventType: string, handler: SSEEventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }
    this.handlers.get(eventType)!.add(handler)
    return () => this.handlers.get(eventType)?.delete(handler)
  }

  onConnection(handler: ConnectionStateHandler): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  private dispatch(e: MessageEvent): void {
    if (e.lastEventId) {
      this.lastEventId = e.lastEventId
    }

    const event: SSEEvent = {
      id: e.lastEventId ?? "",
      type: e.type ?? "message",
      data: String(e.data),
    }

    // Dispatch to type-specific handlers
    this.handlers.get(event.type)?.forEach((h) => h(event))
    // Dispatch to wildcard handlers
    this.handlers.get("*")?.forEach((h) => h(event))
  }
}
