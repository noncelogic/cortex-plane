/**
 * EventSource wrapper with Last-Event-ID reconnection and exponential backoff.
 *
 * Native EventSource doesn't support custom headers, so for authenticated
 * SSE we proxy through Next.js API routes. This wrapper handles:
 * - Automatic reconnection with Last-Event-ID
 * - Exponential backoff on repeated failures
 * - Connection state tracking (connecting / connected / disconnected)
 * - Event parsing and typed dispatch
 */

export interface SSEEvent {
  id: string
  type: string
  data: string
}

export type SSEEventHandler = (event: SSEEvent) => void

export type SSEConnectionStatus = "connecting" | "connected" | "disconnected"
type StatusHandler = (status: SSEConnectionStatus) => void

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

const KNOWN_EVENT_TYPES = [
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
  "job:created",
  "job:updated",
  "job:completed",
  "job:failed",
] as const

/**
 * Resolves an SSE URL. When NEXT_PUBLIC_SSE_URL is set, absolute URLs are
 * built from that base; otherwise relative URLs go through the Next.js rewrite proxy.
 */
export function resolveSSEUrl(path: string): string {
  const base = typeof window !== "undefined" ? (process.env.NEXT_PUBLIC_SSE_URL ?? "") : ""
  if (!base) return path
  // Strip leading /api/ prefix when using a direct SSE URL since the
  // control-plane doesn't serve under /api
  const cleaned = path.startsWith("/api/") ? path.slice(4) : path
  return `${base.replace(/\/$/, "")}${cleaned}`
}

export class SSEClient {
  private eventSource: EventSource | null = null
  private lastEventId: string | null = null
  private handlers = new Map<string, Set<SSEEventHandler>>()
  private statusHandlers = new Set<StatusHandler>()
  private url: string
  private _status: SSEConnectionStatus = "disconnected"
  private backoffMs = INITIAL_BACKOFF_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private consecutiveErrors = 0

  constructor(url: string) {
    this.url = url
  }

  get status(): SSEConnectionStatus {
    return this._status
  }

  connect(): void {
    if (this.eventSource) return
    this.clearReconnectTimer()

    this.setStatus("connecting")

    const connectUrl = this.lastEventId
      ? `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${this.lastEventId}`
      : this.url

    this.eventSource = new EventSource(connectUrl)

    this.eventSource.onopen = () => {
      this.consecutiveErrors = 0
      this.backoffMs = INITIAL_BACKOFF_MS
      this.setStatus("connected")
    }

    this.eventSource.onerror = () => {
      this.consecutiveErrors++
      this.closeSource()
      this.setStatus("disconnected")
      this.scheduleReconnect()
    }

    this.eventSource.onmessage = (e) => {
      this.dispatch(e)
    }

    for (const type of KNOWN_EVENT_TYPES) {
      this.eventSource.addEventListener(type, (e) => this.dispatch(e))
    }
  }

  disconnect(): void {
    this.clearReconnectTimer()
    this.closeSource()
    this.consecutiveErrors = 0
    this.backoffMs = INITIAL_BACKOFF_MS
    this.setStatus("disconnected")
  }

  on(eventType: string, handler: SSEEventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }
    this.handlers.get(eventType)!.add(handler)
    return () => this.handlers.get(eventType)?.delete(handler)
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  /** @deprecated Use onStatus instead */
  onConnection(handler: (connected: boolean) => void): () => void {
    const wrapped: StatusHandler = (s) => handler(s === "connected")
    return this.onStatus(wrapped)
  }

  private setStatus(status: SSEConnectionStatus): void {
    this._status = status
    this.statusHandlers.forEach((h) => h(status))
  }

  private closeSource(): void {
    this.eventSource?.close()
    this.eventSource = null
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    // Exponential backoff with jitter: base * 2^errors, capped at MAX_BACKOFF_MS
    const jitter = Math.random() * 0.3 * this.backoffMs
    const delay = Math.min(this.backoffMs + jitter, MAX_BACKOFF_MS)
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
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
