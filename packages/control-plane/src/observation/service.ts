/**
 * Browser Observation Service
 *
 * Manages live VNC streaming, screenshot capture (degraded mode),
 * Playwright trace recording, multi-tab queries, and annotation
 * forwarding for a given agent's Playwright sidecar.
 *
 * The control plane proxies or wraps the sidecar's capabilities;
 * it does not run Playwright directly — it talks to the sidecar
 * via CDP (Chrome DevTools Protocol) and VNC endpoints.
 */

import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { WebSocket } from "ws"

import type {
  AnnotationEvent,
  AnnotationResult,
  ObservationServiceConfig,
  ScreenshotRequest,
  ScreenshotResult,
  StreamQuality,
  StreamStatus,
  TabInfo,
  TabListResult,
  TraceDownloadResult,
  TraceRecordingOptions,
  TraceState,
  TraceStatus,
  VncEndpointInfo,
} from "./types.js"

const DEFAULT_CDP_HOST = "127.0.0.1"
const DEFAULT_CDP_PORT = 9222
const DEFAULT_WEBSOCKIFY_PORT = 6080
const DEFAULT_VNC_PORT = 5900
const DEFAULT_TRACE_DIR = "/workspace/traces"
const DEFAULT_ASSET_DIR = "/workspace/browser"

// ---------------------------------------------------------------------------
// Per-agent observation state
// ---------------------------------------------------------------------------

interface AgentObservationState {
  traceStatus: TraceStatus
  traceStartedAt: string | null
  traceOptions: TraceRecordingOptions | null
  /** WebSocket connection to CDP for this agent. */
  cdpWs: WebSocket | null
  /** Pending annotation callbacks. */
  annotationListeners: Map<string, (event: AnnotationEvent) => void>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BrowserObservationService {
  private readonly cdpHost: string
  private readonly cdpPort: number
  private readonly websockifyPort: number
  private readonly vncPort: number
  private readonly traceDir: string
  private readonly assetDir: string

  /** agentId → per-agent observation state */
  private readonly agents = new Map<string, AgentObservationState>()

  constructor(config: ObservationServiceConfig = {}) {
    this.cdpHost = config.cdpHost ?? DEFAULT_CDP_HOST
    this.cdpPort = config.cdpPort ?? DEFAULT_CDP_PORT
    this.websockifyPort = config.websockifyPort ?? DEFAULT_WEBSOCKIFY_PORT
    this.vncPort = config.vncPort ?? DEFAULT_VNC_PORT
    this.traceDir = config.traceDir ?? DEFAULT_TRACE_DIR
    this.assetDir = config.assetDir ?? DEFAULT_ASSET_DIR
  }

  // -------------------------------------------------------------------------
  // VNC / Stream Status
  // -------------------------------------------------------------------------

  /**
   * Check VNC availability and return connection info.
   */
  async getStreamStatus(agentId: string): Promise<StreamStatus> {
    const vncEndpoint = await this.getVncEndpoint(agentId)
    const quality: StreamQuality = vncEndpoint?.available ? "live" : "degraded"

    return {
      agentId,
      quality,
      fps: quality === "live" ? 30 : 0,
      lastFrameAt: null,
      vncEndpoint,
    }
  }

  /**
   * Get the VNC endpoint info for the agent's sidecar.
   */
  async getVncEndpoint(_agentId: string): Promise<VncEndpointInfo | null> {
    const available = await this.isVncAvailable()
    if (!available) return null

    return {
      websocketUrl: `ws://${this.cdpHost}:${this.websockifyPort}`,
      vncAddress: `${this.cdpHost}:${this.vncPort}`,
      available: true,
    }
  }

  /**
   * Proxy a WebSocket connection to the sidecar's websockify endpoint.
   * Accepts the client-side WebSocket from @fastify/websocket and bridges
   * it to the upstream websockify instance in the sidecar.
   */
  proxyVncWebSocket(clientWs: WebSocket): WebSocket {
    const target = `ws://${this.cdpHost}:${this.websockifyPort}`
    const upstream = new WebSocket(target, ["binary"], {
      perMessageDeflate: false,
    })

    upstream.on("message", (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data)
      }
    })

    clientWs.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data)
      }
    })

    clientWs.on("close", () => upstream.close())
    clientWs.on("error", () => upstream.close())
    upstream.on("close", () => clientWs.close())
    upstream.on("error", () => clientWs.close())

    return upstream
  }

  // -------------------------------------------------------------------------
  // Screenshot (degraded mode)
  // -------------------------------------------------------------------------

  /**
   * Capture a screenshot of the current page via CDP.
   */
  async captureScreenshot(agentId: string, request: ScreenshotRequest = {}): Promise<ScreenshotResult> {
    const format = request.format ?? "jpeg"
    const quality = format === "jpeg" ? (request.quality ?? 70) : undefined
    const fullPage = request.fullPage ?? false

    const wsEndpoint = await this.discoverCdpWsEndpoint()
    const ws = new WebSocket(wsEndpoint)

    try {
      await this.waitForWsOpen(ws)

      // Get the list of targets to find the first page
      const targets = await this.cdpSend<{ targetInfos: Array<{ type: string; targetId: string; url: string; title: string }> }>(
        ws,
        "Target.getTargets",
        {},
      )

      const pageTarget = targets.targetInfos.find((t) => t.type === "page")
      if (!pageTarget) {
        throw new Error("No browser page found")
      }

      // Attach to the target
      const { sessionId } = await this.cdpSend<{ sessionId: string }>(
        ws,
        "Target.attachToTarget",
        { targetId: pageTarget.targetId, flatten: true },
      )

      // If fullPage, get the full document dimensions first
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
      if (fullPage) {
        const layout = await this.cdpSendSession<{
          contentSize: { width: number; height: number }
        }>(ws, sessionId, "Page.getLayoutMetrics", {})
        clip = {
          x: 0,
          y: 0,
          width: layout.contentSize.width,
          height: layout.contentSize.height,
          scale: 1,
        }
      }

      // Capture screenshot
      const result = await this.cdpSendSession<{ data: string; metadata?: { width?: number; height?: number } }>(
        ws,
        sessionId,
        "Page.captureScreenshot",
        {
          format,
          quality,
          clip,
          fromSurface: true,
        },
      )

      return {
        agentId,
        data: result.data,
        format,
        width: result.metadata?.width ?? 1280,
        height: result.metadata?.height ?? 720,
        timestamp: new Date().toISOString(),
        url: pageTarget.url,
        title: pageTarget.title,
      }
    } finally {
      ws.close()
    }
  }

  // -------------------------------------------------------------------------
  // Multi-tab awareness
  // -------------------------------------------------------------------------

  /**
   * Query all open tabs in the browser context.
   */
  async listTabs(agentId: string): Promise<TabListResult> {
    const wsEndpoint = await this.discoverCdpWsEndpoint()
    const ws = new WebSocket(wsEndpoint)

    try {
      await this.waitForWsOpen(ws)

      const result = await this.cdpSend<{
        targetInfos: Array<{
          type: string
          targetId: string
          url: string
          title: string
          attached: boolean
        }>
      }>(ws, "Target.getTargets", {})

      const pages = result.targetInfos.filter((t) => t.type === "page")

      const tabs: TabInfo[] = pages.map((page, index) => ({
        index,
        url: page.url,
        title: page.title,
        active: index === 0, // First page is typically active
      }))

      return {
        agentId,
        tabs,
        timestamp: new Date().toISOString(),
      }
    } finally {
      ws.close()
    }
  }

  // -------------------------------------------------------------------------
  // Trace Recording (Playwright Trace Viewer)
  // -------------------------------------------------------------------------

  /**
   * Get the current trace recording state.
   */
  getTraceState(agentId: string): TraceState {
    const state = this.getAgentState(agentId)
    return {
      agentId,
      status: state.traceStatus,
      startedAt: state.traceStartedAt,
      options: state.traceOptions,
    }
  }

  /**
   * Start trace recording via CDP.
   */
  async startTrace(agentId: string, options: TraceRecordingOptions = {}): Promise<TraceState> {
    const state = this.getAgentState(agentId)

    if (state.traceStatus === "recording") {
      throw new Error(`Trace recording already in progress for agent ${agentId}`)
    }

    const traceOptions: TraceRecordingOptions = {
      snapshots: options.snapshots ?? true,
      screenshots: options.screenshots ?? true,
      network: options.network ?? true,
      console: options.console ?? true,
    }

    await fs.mkdir(this.traceDir, { recursive: true })

    // Use CDP to enable tracing domains
    const wsEndpoint = await this.discoverCdpWsEndpoint()
    const ws = new WebSocket(wsEndpoint)

    try {
      await this.waitForWsOpen(ws)

      const targets = await this.cdpSend<{ targetInfos: Array<{ type: string; targetId: string }> }>(
        ws,
        "Target.getTargets",
        {},
      )
      const pageTarget = targets.targetInfos.find((t) => t.type === "page")
      if (!pageTarget) throw new Error("No browser page found for tracing")

      const { sessionId } = await this.cdpSend<{ sessionId: string }>(
        ws,
        "Target.attachToTarget",
        { targetId: pageTarget.targetId, flatten: true },
      )

      // Enable tracing categories
      const categories: string[] = []
      if (traceOptions.network) categories.push("-*", "devtools.timeline", "v8.execute")
      if (traceOptions.snapshots) categories.push("disabled-by-default-devtools.timeline.frame")

      await this.cdpSendSession(ws, sessionId, "Tracing.start", {
        categories: categories.join(","),
        options: "sampling-frequency=10000",
      })

      if (traceOptions.network) {
        await this.cdpSendSession(ws, sessionId, "Network.enable", {})
      }
      if (traceOptions.console) {
        await this.cdpSendSession(ws, sessionId, "Runtime.enable", {})
      }
    } finally {
      ws.close()
    }

    state.traceStatus = "recording"
    state.traceStartedAt = new Date().toISOString()
    state.traceOptions = traceOptions

    return this.getTraceState(agentId)
  }

  /**
   * Stop trace recording and save to file.
   */
  async stopTrace(agentId: string): Promise<TraceDownloadResult> {
    const state = this.getAgentState(agentId)

    if (state.traceStatus !== "recording") {
      throw new Error(`No active trace recording for agent ${agentId}`)
    }

    state.traceStatus = "stopping"
    const startedAt = state.traceStartedAt!

    const wsEndpoint = await this.discoverCdpWsEndpoint()
    const ws = new WebSocket(wsEndpoint)

    try {
      await this.waitForWsOpen(ws)

      const targets = await this.cdpSend<{ targetInfos: Array<{ type: string; targetId: string }> }>(
        ws,
        "Target.getTargets",
        {},
      )
      const pageTarget = targets.targetInfos.find((t) => t.type === "page")
      if (!pageTarget) throw new Error("No browser page found for tracing")

      const { sessionId } = await this.cdpSend<{ sessionId: string }>(
        ws,
        "Target.attachToTarget",
        { targetId: pageTarget.targetId, flatten: true },
      )

      // Stop tracing and collect data
      await this.cdpSendSession(ws, sessionId, "Tracing.end", {})

      // Wait for tracingComplete event
      const traceData = await new Promise<string>((resolve, reject) => {
        const chunks: string[] = []
        const timeout = setTimeout(() => reject(new Error("Trace collection timed out")), 30_000)

        const handler = (rawMsg: Buffer | string) => {
          const msg = JSON.parse(rawMsg.toString()) as {
            method?: string
            params?: { value?: string[]; dataCollected?: boolean }
          }

          if (msg.method === "Tracing.dataCollected" && msg.params?.value) {
            chunks.push(...msg.params.value.map((v) => JSON.stringify(v)))
          }

          if (msg.method === "Tracing.tracingComplete") {
            clearTimeout(timeout)
            ws.off("message", handler)
            resolve(`[${chunks.join(",")}]`)
          }
        }

        ws.on("message", handler)
      })

      // Save trace data
      await fs.mkdir(this.traceDir, { recursive: true })
      const filename = `trace-${agentId}-${Date.now()}.json`
      const filePath = path.join(this.traceDir, filename)
      await fs.writeFile(filePath, traceData, "utf-8")

      const stats = await fs.stat(filePath)
      const durationMs = Date.now() - new Date(startedAt).getTime()

      state.traceStatus = "idle"
      state.traceStartedAt = null
      state.traceOptions = null

      return {
        agentId,
        filePath,
        sizeBytes: stats.size,
        durationMs,
        timestamp: new Date().toISOString(),
      }
    } catch (err) {
      state.traceStatus = "idle"
      state.traceStartedAt = null
      throw err
    } finally {
      ws.close()
    }
  }

  // -------------------------------------------------------------------------
  // Annotation / Event Forwarding
  // -------------------------------------------------------------------------

  /**
   * Register a listener for annotation events forwarded to a specific agent.
   */
  onAnnotation(agentId: string, listener: (event: AnnotationEvent) => void): () => void {
    const state = this.getAgentState(agentId)
    const id = randomUUID()
    state.annotationListeners.set(id, listener)
    return () => {
      state.annotationListeners.delete(id)
    }
  }

  /**
   * Forward a user annotation (click, hover, etc.) to the agent.
   * Generates a coordinate-based prompt for the agent's next action.
   */
  async forwardAnnotation(agentId: string, event: AnnotationEvent): Promise<AnnotationResult> {
    const annotationId = randomUUID()
    const state = this.getAgentState(agentId)

    // Notify all registered listeners
    for (const listener of state.annotationListeners.values()) {
      try {
        listener(event)
      } catch {
        // swallow listener errors
      }
    }

    return {
      agentId,
      annotationId,
      forwarded: state.annotationListeners.size > 0,
      timestamp: new Date().toISOString(),
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Clean up all state for an agent.
   */
  async cleanup(agentId: string): Promise<void> {
    const state = this.agents.get(agentId)
    if (!state) return

    if (state.cdpWs) {
      state.cdpWs.close()
    }
    state.annotationListeners.clear()
    this.agents.delete(agentId)
  }

  /**
   * Shut down the service and clean up all agents.
   */
  async shutdown(): Promise<void> {
    for (const agentId of this.agents.keys()) {
      await this.cleanup(agentId)
    }
  }

  // -------------------------------------------------------------------------
  // Private: CDP Communication
  // -------------------------------------------------------------------------

  private async discoverCdpWsEndpoint(): Promise<string> {
    const res = await fetch(`http://${this.cdpHost}:${this.cdpPort}/json/version`)
    if (!res.ok) {
      throw new Error(`CDP version endpoint returned ${res.status}`)
    }
    const data = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (!data.webSocketDebuggerUrl) {
      throw new Error("No webSocketDebuggerUrl in CDP /json/version response")
    }
    return data.webSocketDebuggerUrl
  }

  private async isVncAvailable(): Promise<boolean> {
    try {
      // Probe the websockify port with a quick TCP-level check
      const res = await fetch(`http://${this.cdpHost}:${this.websockifyPort}`, {
        signal: AbortSignal.timeout(2_000),
      })
      // websockify returns 200 or 400 depending on path — any response means it's up
      return res.status < 500
    } catch {
      return false
    }
  }

  private waitForWsOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket connection timeout")), 5_000)
      ws.on("open", () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.on("error", (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private cdpSend<T>(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1_000_000)
      const timeout = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 10_000)

      const handler = (rawMsg: Buffer | string) => {
        const msg = JSON.parse(rawMsg.toString()) as { id?: number; result?: T; error?: { message: string } }
        if (msg.id !== id) return

        clearTimeout(timeout)
        ws.off("message", handler)

        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`))
        } else {
          resolve(msg.result as T)
        }
      }

      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private cdpSendSession<T>(
    ws: WebSocket,
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1_000_000)
      const timeout = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 10_000)

      const handler = (rawMsg: Buffer | string) => {
        const msg = JSON.parse(rawMsg.toString()) as { id?: number; result?: T; error?: { message: string } }
        if (msg.id !== id) return

        clearTimeout(timeout)
        ws.off("message", handler)

        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`))
        } else {
          resolve(msg.result as T)
        }
      }

      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  // -------------------------------------------------------------------------
  // Private: Per-agent state
  // -------------------------------------------------------------------------

  private getAgentState(agentId: string): AgentObservationState {
    let state = this.agents.get(agentId)
    if (!state) {
      state = {
        traceStatus: "idle",
        traceStartedAt: null,
        traceOptions: null,
        cdpWs: null,
        annotationListeners: new Map(),
      }
      this.agents.set(agentId, state)
    }
    return state
  }
}
