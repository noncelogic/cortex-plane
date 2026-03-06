/**
 * Sidecar Transport — unit tests
 *
 * Mocks the @kubernetes/client-node Exec API to verify that the
 * SidecarTransport correctly:
 *   - starts an exec session with the right parameters
 *   - parses JSON-RPC messages from stdout
 *   - writes JSON-RPC messages to stdin
 *   - handles close and error events
 */

import { EventEmitter } from "node:events"
import type { PassThrough } from "node:stream"

import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock @kubernetes/client-node
// ---------------------------------------------------------------------------

const { mockExec } = vi.hoisted(() => {
  return {
    mockExec: vi.fn(),
  }
})

vi.mock("@kubernetes/client-node", () => {
  class FakeKubeConfig {
    loadFromDefault = vi.fn()
  }
  class FakeExec {
    exec = mockExec
  }
  return {
    KubeConfig: FakeKubeConfig,
    Exec: FakeExec,
  }
})

import { KubeConfig } from "@kubernetes/client-node"

import { SidecarTransport } from "../mcp/sidecar-transport.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs(): EventEmitter {
  return new EventEmitter()
}

const TARGET = {
  podName: "agent-devops-01",
  containerName: "mcp-sidecar-brave",
  namespace: "cortex-plane",
  command: ["node", "/opt/server.js"],
} as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidecarTransport", () => {
  let kc: KubeConfig

  beforeEach(() => {
    vi.clearAllMocks()
    kc = new KubeConfig()
  })

  it("calls exec with correct parameters", async () => {
    const ws = createMockWs()
    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: PassThrough,
        _tty: boolean,
      ) => Promise.resolve(ws),
    )

    const transport = new SidecarTransport(kc, TARGET)
    await transport.start()

    expect(mockExec).toHaveBeenCalledOnce()
    expect(mockExec).toHaveBeenCalledWith(
      "cortex-plane",
      "agent-devops-01",
      "mcp-sidecar-brave",
      ["node", "/opt/server.js"],
      expect.anything(), // stdout
      expect.anything(), // stderr
      expect.anything(), // stdin
      false, // tty
    )

    await transport.close()
  })

  it("parses JSON-RPC messages from stdout", async () => {
    const ws = createMockWs()
    let capturedStdout: PassThrough | null = null

    mockExec.mockImplementation(
      (_ns: string, _pod: string, _container: string, _cmd: string[], stdout: PassThrough) => {
        capturedStdout = stdout
        return Promise.resolve(ws)
      },
    )

    const transport = new SidecarTransport(kc, TARGET)
    const received: unknown[] = []
    transport.onmessage = (msg) => received.push(msg)

    await transport.start()

    // Write a JSON-RPC message to stdout
    const jsonRpc = { jsonrpc: "2.0", id: 1, result: { tools: [] } }
    capturedStdout!.write(JSON.stringify(jsonRpc) + "\n")

    // Allow readline to process
    await new Promise((r) => setTimeout(r, 10))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(jsonRpc)

    await transport.close()
  })

  it("ignores non-JSON lines from stdout", async () => {
    const ws = createMockWs()
    let capturedStdout: PassThrough | null = null

    mockExec.mockImplementation(
      (_ns: string, _pod: string, _container: string, _cmd: string[], stdout: PassThrough) => {
        capturedStdout = stdout
        return Promise.resolve(ws)
      },
    )

    const transport = new SidecarTransport(kc, TARGET)
    const received: unknown[] = []
    transport.onmessage = (msg) => received.push(msg)

    await transport.start()

    capturedStdout!.write("Starting MCP server...\n")
    capturedStdout!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n")

    await new Promise((r) => setTimeout(r, 10))

    expect(received).toHaveLength(1)

    await transport.close()
  })

  it("sends JSON-RPC messages to stdin", async () => {
    const ws = createMockWs()
    let capturedStdin: PassThrough | null = null

    mockExec.mockImplementation(
      (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        stdin: PassThrough,
      ) => {
        capturedStdin = stdin
        return Promise.resolve(ws)
      },
    )

    const transport = new SidecarTransport(kc, TARGET)
    await transport.start()

    const chunks: Buffer[] = []
    capturedStdin!.on("data", (chunk: Buffer) => chunks.push(chunk))

    const message = { jsonrpc: "2.0" as const, method: "initialize", id: 1, params: {} }
    await transport.send(message)

    const written = Buffer.concat(chunks).toString()
    expect(written).toBe(JSON.stringify(message) + "\n")

    await transport.close()
  })

  it("throws when sending on a closed transport", async () => {
    const ws = createMockWs()
    mockExec.mockResolvedValue(ws)

    const transport = new SidecarTransport(kc, TARGET)
    await transport.start()
    await transport.close()

    await expect(transport.send({ jsonrpc: "2.0", method: "ping", id: 2 })).rejects.toThrow(
      /closed/,
    )
  })

  it("invokes onclose when WebSocket closes", async () => {
    const ws = createMockWs()
    mockExec.mockResolvedValue(ws)

    const transport = new SidecarTransport(kc, TARGET)
    const closeSpy = vi.fn()
    transport.onclose = closeSpy

    await transport.start()

    ws.emit("close")

    expect(closeSpy).toHaveBeenCalledOnce()
  })

  it("invokes onerror when WebSocket emits error", async () => {
    const ws = createMockWs()
    mockExec.mockResolvedValue(ws)

    const transport = new SidecarTransport(kc, TARGET)
    const errorSpy = vi.fn()
    transport.onerror = errorSpy

    await transport.start()

    ws.emit("error", new Error("connection lost"))

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: "connection lost" }))
  })

  it("close is idempotent", async () => {
    const ws = createMockWs()
    mockExec.mockResolvedValue(ws)

    const transport = new SidecarTransport(kc, TARGET)
    const closeSpy = vi.fn()
    transport.onclose = closeSpy

    await transport.start()
    await transport.close()
    await transport.close()

    // onclose should only be called once
    expect(closeSpy).toHaveBeenCalledOnce()
  })
})
