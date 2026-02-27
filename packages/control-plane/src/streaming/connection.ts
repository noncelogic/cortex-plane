/**
 * SSE Connection — wraps a raw Node.js ServerResponse for SSE streaming.
 *
 * Handles:
 * - SSE framing (id, event, data fields)
 * - Per-connection write buffer with backpressure detection
 * - Heartbeat keep-alive pings
 * - Clean teardown on disconnect
 */

import type { ServerResponse } from "node:http"

import type { BufferConfig, SSEEvent } from "./types.js"
import { DEFAULT_BUFFER_CONFIG } from "./types.js"

export class SSEConnection {
  readonly connectionId: string
  readonly agentId: string
  readonly connectedAt: Date

  private readonly response: ServerResponse
  private readonly config: BufferConfig
  private readonly pendingWrites: SSEEvent[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _eventCount = 0
  private _lastEventId: string | null = null
  private _closed = false
  private draining = false

  constructor(
    connectionId: string,
    agentId: string,
    response: ServerResponse,
    config: Partial<BufferConfig> = {},
  ) {
    this.connectionId = connectionId
    this.agentId = agentId
    this.connectedAt = new Date()
    this.response = response
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config }

    // Write SSE headers
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    // Detect client disconnect
    response.on("close", () => {
      this._closed = true
      this.stopHeartbeat()
    })

    this.startHeartbeat()
  }

  get closed(): boolean {
    return this._closed
  }

  get eventCount(): number {
    return this._eventCount
  }

  get lastEventId(): string | null {
    return this._lastEventId
  }

  get bufferSize(): number {
    return this.pendingWrites.length
  }

  /**
   * Send an SSE event to the client.
   * Returns false if the connection is closed or the buffer is full (backpressure).
   */
  send(event: SSEEvent): boolean {
    if (this._closed) return false

    // Backpressure: if the write buffer is full, drop the event
    if (this.pendingWrites.length >= this.config.maxBufferSize) {
      return false
    }

    const frame = formatSSEFrame(event)
    const ok = this.response.write(frame)

    this._eventCount++
    this._lastEventId = event.id

    if (!ok && !this.draining) {
      // The kernel buffer is full — enable drain tracking
      this.draining = true
      this.response.once("drain", () => {
        this.draining = false
        this.flushPending()
      })
    }

    return true
  }

  /**
   * Send a comment line (for keep-alive heartbeats).
   */
  sendComment(text: string): boolean {
    if (this._closed) return false
    return this.response.write(`:${text}\n\n`)
  }

  /**
   * Close the SSE connection gracefully.
   */
  close(): void {
    if (this._closed) return
    this._closed = true
    this.stopHeartbeat()
    this.response.end()
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this._closed) {
        this.stopHeartbeat()
        return
      }
      this.sendComment("heartbeat")
    }, this.config.heartbeatIntervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private flushPending(): void {
    while (this.pendingWrites.length > 0 && !this._closed && !this.draining) {
      const event = this.pendingWrites.shift()!
      const frame = formatSSEFrame(event)
      const ok = this.response.write(frame)
      this._eventCount++
      this._lastEventId = event.id

      if (!ok) {
        this.draining = true
        this.response.once("drain", () => {
          this.draining = false
          this.flushPending()
        })
        break
      }
    }
  }
}

/**
 * Format an SSE event into the wire format.
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
function formatSSEFrame(event: SSEEvent): string {
  let frame = ""
  frame += `id:${event.id}\n`
  frame += `event:${event.event}\n`
  // Split data by newlines to comply with SSE spec
  for (const line of event.data.split("\n")) {
    frame += `data:${line}\n`
  }
  frame += "\n"
  return frame
}
