/**
 * SSE Connection Manager — manages SSE connections per agent.
 *
 * Responsibilities:
 * - Track active connections per agent
 * - Maintain per-agent replay buffers for reconnect
 * - Broadcast events to all connections for an agent
 * - Generate monotonically increasing event IDs
 * - Replay missed events on reconnect
 * - Clean up dead connections
 */

import type { ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"

import { SSEConnection } from "./connection.js"
import type { SSEEvent, SSEEventType, BufferConfig, SSEConnectionInfo } from "./types.js"
import { DEFAULT_BUFFER_CONFIG } from "./types.js"

export class SSEConnectionManager {
  /** agentId → Set of active connections */
  private readonly connections = new Map<string, Set<SSEConnection>>()
  /** agentId → circular replay buffer of recent events */
  private readonly replayBuffers = new Map<string, SSEEvent[]>()
  /** agentId → monotonically increasing event counter */
  private readonly eventCounters = new Map<string, number>()
  private readonly config: BufferConfig

  constructor(config: Partial<BufferConfig> = {}) {
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config }
  }

  /**
   * Register a new SSE connection for an agent.
   * If lastEventId is provided, replays missed events before returning.
   */
  connect(
    agentId: string,
    response: ServerResponse,
    lastEventId: string | null = null,
  ): SSEConnection {
    const connectionId = randomUUID()
    const conn = new SSEConnection(connectionId, agentId, response, this.config)

    if (!this.connections.has(agentId)) {
      this.connections.set(agentId, new Set())
    }
    this.connections.get(agentId)!.add(conn)

    // Auto-remove on disconnect
    response.on("close", () => {
      this.connections.get(agentId)?.delete(conn)
      if (this.connections.get(agentId)?.size === 0) {
        this.connections.delete(agentId)
      }
    })

    // Replay missed events if reconnecting
    if (lastEventId) {
      this.replayFrom(conn, agentId, lastEventId)
    }

    return conn
  }

  /**
   * Broadcast an event to all connections for an agent.
   * Automatically generates an event ID and stores in replay buffer.
   */
  broadcast(agentId: string, event: SSEEventType, data: unknown): SSEEvent {
    const id = this.nextEventId(agentId)
    const sseEvent: SSEEvent = {
      id,
      event,
      data: JSON.stringify(data),
    }

    // Store in replay buffer
    this.addToReplayBuffer(agentId, sseEvent)

    // Send to all active connections
    const conns = this.connections.get(agentId)
    if (conns) {
      for (const conn of conns) {
        if (conn.closed) {
          conns.delete(conn)
          continue
        }
        const ok = conn.send(sseEvent)
        if (!ok) {
          // Backpressure or closed — remove dead connection
          conn.close()
          conns.delete(conn)
        }
      }
      if (conns.size === 0) {
        this.connections.delete(agentId)
      }
    }

    return sseEvent
  }

  /**
   * Close all connections for an agent and clear its replay buffer.
   */
  disconnectAll(agentId: string): void {
    const conns = this.connections.get(agentId)
    if (conns) {
      for (const conn of conns) {
        conn.close()
      }
      this.connections.delete(agentId)
    }
    this.replayBuffers.delete(agentId)
    this.eventCounters.delete(agentId)
  }

  /**
   * Get connection info for an agent.
   */
  getConnections(agentId: string): SSEConnectionInfo[] {
    const conns = this.connections.get(agentId)
    if (!conns) return []

    return [...conns]
      .filter((c) => !c.closed)
      .map((c) => ({
        connectionId: c.connectionId,
        agentId: c.agentId,
        connectedAt: c.connectedAt,
        lastEventId: c.lastEventId,
        eventCount: c.eventCount,
      }))
  }

  /**
   * Get count of active connections for an agent.
   */
  connectionCount(agentId: string): number {
    const conns = this.connections.get(agentId)
    if (!conns) return 0
    // Prune dead connections
    for (const conn of conns) {
      if (conn.closed) conns.delete(conn)
    }
    return conns.size
  }

  /**
   * Total active connections across all agents.
   */
  get totalConnectionCount(): number {
    let total = 0
    for (const [, conns] of this.connections) {
      for (const conn of conns) {
        if (!conn.closed) total++
      }
    }
    return total
  }

  /**
   * Shut down the manager: close all connections, clear all buffers.
   */
  shutdown(): void {
    for (const [agentId] of this.connections) {
      this.disconnectAll(agentId)
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private nextEventId(agentId: string): string {
    const counter = (this.eventCounters.get(agentId) ?? 0) + 1
    this.eventCounters.set(agentId, counter)
    return `${agentId}:${counter}`
  }

  private addToReplayBuffer(agentId: string, event: SSEEvent): void {
    if (!this.replayBuffers.has(agentId)) {
      this.replayBuffers.set(agentId, [])
    }
    const buffer = this.replayBuffers.get(agentId)!
    buffer.push(event)

    // Trim to max replay buffer size
    while (buffer.length > this.config.maxReplayBufferSize) {
      buffer.shift()
    }
  }

  private replayFrom(conn: SSEConnection, agentId: string, lastEventId: string): void {
    const buffer = this.replayBuffers.get(agentId)
    if (!buffer || buffer.length === 0) return

    // Find the index after the last received event
    const idx = buffer.findIndex((e) => e.id === lastEventId)
    if (idx === -1) {
      // Event not in buffer — replay everything we have
      for (const event of buffer) {
        if (!conn.send(event)) break
      }
      return
    }

    // Replay everything after the last received event
    for (let i = idx + 1; i < buffer.length; i++) {
      const event = buffer[i]
      if (!event || !conn.send(event)) break
    }
  }
}
