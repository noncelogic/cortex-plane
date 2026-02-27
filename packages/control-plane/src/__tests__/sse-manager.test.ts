import type { ServerResponse } from "node:http"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SSEConnectionManager } from "../streaming/manager.js"

function createMockResponse(): ServerResponse & {
  chunks: string[]
  _listeners: Map<string, (...args: unknown[]) => unknown>
} {
  const chunks: string[] = []
  const listeners = new Map<string, (...args: unknown[]) => unknown>()

  return {
    chunks,
    _listeners: listeners,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk)
      return true
    }),
    end: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
      listeners.set(event, cb)
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => unknown) => {
      listeners.set(event, cb)
    }),
  } as unknown as ServerResponse & {
    chunks: string[]
    _listeners: Map<string, (...args: unknown[]) => unknown>
  }
}

describe("SSEConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("connects and tracks connections", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res = createMockResponse()

    const conn = manager.connect("agent-1", res)

    expect(conn.agentId).toBe("agent-1")
    expect(conn.closed).toBe(false)
    expect(manager.connectionCount("agent-1")).toBe(1)
    expect(manager.totalConnectionCount).toBe(1)

    manager.shutdown()
  })

  it("supports multiple connections per agent", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-1", res2)

    expect(manager.connectionCount("agent-1")).toBe(2)

    manager.shutdown()
  })

  it("broadcasts events to all connections for an agent", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-1", res2)

    const event = manager.broadcast("agent-1", "agent:output", { text: "hello" })

    expect(event.id).toBe("agent-1:1")
    expect(event.event).toBe("agent:output")

    // Both responses should have received the event (plus the initial state broadcast is not here)
    // Check that write was called on both
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res1.write).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res2.write).toHaveBeenCalled()

    // Verify the frame format in one of them
    const lastChunk = res1.chunks[res1.chunks.length - 1]
    expect(lastChunk).toContain("id:agent-1:1")
    expect(lastChunk).toContain("event:agent:output")
    expect(lastChunk).toContain('data:{"text":"hello"}')

    manager.shutdown()
  })

  it("does not broadcast to other agents", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-2", res2)

    manager.broadcast("agent-1", "agent:output", { text: "for agent-1 only" })

    // res2 should only have the writeHead call, no data writes for agent-1's broadcast
    const agent2Chunks = res2.chunks.filter((c) => c.includes("agent-1:"))
    expect(agent2Chunks).toHaveLength(0)

    manager.shutdown()
  })

  it("generates monotonically increasing event IDs per agent", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res = createMockResponse()
    manager.connect("agent-1", res)

    const e1 = manager.broadcast("agent-1", "agent:output", {})
    const e2 = manager.broadcast("agent-1", "agent:output", {})
    const e3 = manager.broadcast("agent-1", "agent:output", {})

    expect(e1.id).toBe("agent-1:1")
    expect(e2.id).toBe("agent-1:2")
    expect(e3.id).toBe("agent-1:3")

    manager.shutdown()
  })

  it("replays missed events on reconnect", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()

    manager.connect("agent-1", res1)

    // Send some events
    manager.broadcast("agent-1", "agent:output", { seq: 1 })
    manager.broadcast("agent-1", "agent:output", { seq: 2 })
    manager.broadcast("agent-1", "agent:output", { seq: 3 })

    // Simulate disconnect
    res1._listeners.get("close")?.()

    // Reconnect with lastEventId = "agent-1:1" (missed events 2 and 3)
    const res2 = createMockResponse()
    manager.connect("agent-1", res2, "agent-1:1")

    // Should have replayed events 2 and 3
    const replayedChunks = res2.chunks.filter((c) => c.includes("agent-1:"))
    expect(replayedChunks.length).toBe(2)
    expect(replayedChunks[0]).toContain("id:agent-1:2")
    expect(replayedChunks[1]).toContain("id:agent-1:3")

    manager.shutdown()
  })

  it("replays all events if lastEventId is not in buffer", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()

    manager.connect("agent-1", res1)

    manager.broadcast("agent-1", "agent:output", { seq: 1 })
    manager.broadcast("agent-1", "agent:output", { seq: 2 })

    // Reconnect with a lastEventId that's not in the buffer
    const res2 = createMockResponse()
    manager.connect("agent-1", res2, "agent-1:0")

    // Should replay everything
    const replayedChunks = res2.chunks.filter((c) => c.includes("agent-1:"))
    expect(replayedChunks.length).toBe(2)

    manager.shutdown()
  })

  it("trims replay buffer to max size", () => {
    const manager = new SSEConnectionManager({
      maxReplayBufferSize: 3,
      heartbeatIntervalMs: 60_000,
    })
    const res1 = createMockResponse()

    manager.connect("agent-1", res1)

    // Send 5 events — only last 3 should be in replay buffer
    for (let i = 1; i <= 5; i++) {
      manager.broadcast("agent-1", "agent:output", { seq: i })
    }

    // Reconnect with lastEventId before all events
    const res2 = createMockResponse()
    manager.connect("agent-1", res2, "agent-1:0")

    // Should only get the last 3 events (3, 4, 5)
    const replayedChunks = res2.chunks.filter((c) => c.includes("agent-1:"))
    expect(replayedChunks.length).toBe(3)
    expect(replayedChunks[0]).toContain("id:agent-1:3")
    expect(replayedChunks[1]).toContain("id:agent-1:4")
    expect(replayedChunks[2]).toContain("id:agent-1:5")

    manager.shutdown()
  })

  it("removes dead connections on broadcast", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-1", res2)

    // Simulate res1 disconnect
    res1._listeners.get("close")?.()

    // Broadcast should detect the dead connection and prune it
    manager.broadcast("agent-1", "agent:output", {})

    expect(manager.connectionCount("agent-1")).toBe(1)

    manager.shutdown()
  })

  it("disconnectAll closes all connections and clears replay buffer", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-1", res2)

    manager.broadcast("agent-1", "agent:output", {})

    manager.disconnectAll("agent-1")

    expect(manager.connectionCount("agent-1")).toBe(0)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res1.end).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res2.end).toHaveBeenCalled()

    // Reconnect — no events to replay since buffer was cleared
    const res3 = createMockResponse()
    manager.connect("agent-1", res3, "agent-1:0")
    const replayedChunks = res3.chunks.filter((c) => c.includes("agent-1:"))
    expect(replayedChunks.length).toBe(0)

    manager.shutdown()
  })

  it("getConnections returns info for active connections", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res = createMockResponse()

    const conn = manager.connect("agent-1", res)

    const infos = manager.getConnections("agent-1")
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      connectionId: conn.connectionId,
      agentId: "agent-1",
      eventCount: 0,
      lastEventId: null,
    })

    manager.shutdown()
  })

  it("shutdown closes all connections across all agents", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res1 = createMockResponse()
    const res2 = createMockResponse()

    manager.connect("agent-1", res1)
    manager.connect("agent-2", res2)

    manager.shutdown()

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res1.end).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(res2.end).toHaveBeenCalled()
    expect(manager.totalConnectionCount).toBe(0)
  })

  it("auto-removes connections on client disconnect", () => {
    const manager = new SSEConnectionManager({ heartbeatIntervalMs: 60_000 })
    const res = createMockResponse()

    manager.connect("agent-1", res)
    expect(manager.connectionCount("agent-1")).toBe(1)

    // Simulate client close
    res._listeners.get("close")?.()
    expect(manager.connectionCount("agent-1")).toBe(0)

    manager.shutdown()
  })
})
