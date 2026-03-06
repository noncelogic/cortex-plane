/**
 * Sidecar Transport
 *
 * MCP transport that connects to a stdio MCP server running as a sidecar
 * container in a Kubernetes pod.  Uses the `@kubernetes/client-node` Exec
 * API to start the MCP server command inside the sidecar container and
 * communicate via JSON-RPC over stdin/stdout.
 *
 * The sidecar container provides the runtime environment (image, volumes)
 * while the MCP server process is started on-demand via exec.
 */

import { PassThrough } from "node:stream"

import * as k8s from "@kubernetes/client-node"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidecarTarget {
  podName: string
  containerName: string
  namespace: string
  command: readonly string[]
}

// ---------------------------------------------------------------------------
// SidecarTransport
// ---------------------------------------------------------------------------

export class SidecarTransport implements Transport {
  private stdinStream: PassThrough | null = null
  private stdoutStream: PassThrough | null = null
  private stderrStream: PassThrough | null = null
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  constructor(
    private kubeConfig: k8s.KubeConfig,
    private target: SidecarTarget,
  ) {}

  async start(): Promise<void> {
    this.stdinStream = new PassThrough()
    this.stdoutStream = new PassThrough()
    this.stderrStream = new PassThrough()

    const exec = new k8s.Exec(this.kubeConfig)

    const ws = await exec.exec(
      this.target.namespace,
      this.target.podName,
      this.target.containerName,
      [...this.target.command],
      this.stdoutStream,
      this.stderrStream,
      this.stdinStream,
      false, // tty
    )

    // Read stdout line by line for JSON-RPC messages
    let buffer = ""
    this.stdoutStream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as JSONRPCMessage
          this.onmessage?.(message)
        } catch {
          // Ignore non-JSON output (startup logs, etc.)
        }
      }
    })

    this.stdoutStream.on("end", () => {
      if (!this.closed) {
        this.closed = true
        this.onclose?.()
      }
    })

    ws.on("error", (err: unknown) => {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)))
    })

    ws.on("close", () => {
      if (!this.closed) {
        this.closed = true
        this.onclose?.()
      }
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.stdinStream) {
      throw new Error("SidecarTransport: transport is closed")
    }
    const json = JSON.stringify(message) + "\n"
    return new Promise<void>((resolve, reject) => {
      this.stdinStream!.write(json, "utf-8", (err?: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.stdinStream?.end()
    this.stdoutStream?.destroy()
    this.stderrStream?.destroy()
    this.onclose?.()
    return Promise.resolve()
  }
}
