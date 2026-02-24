/**
 * Browser observation types.
 *
 * Defines interfaces for live VNC streaming, screenshot capture,
 * trace recording, multi-tab awareness, and annotation forwarding.
 */

// ---------------------------------------------------------------------------
// VNC / Stream Configuration
// ---------------------------------------------------------------------------

export interface VncEndpointInfo {
  /** WebSocket URL for noVNC connection (via websockify). */
  websocketUrl: string
  /** Raw VNC host:port (for direct VNC clients). */
  vncAddress: string
  /** Whether VNC is currently available. */
  available: boolean
}

export type StreamQuality = "live" | "degraded"

export interface StreamStatus {
  agentId: string
  quality: StreamQuality
  fps: number
  /** Timestamp of last received frame or screenshot. */
  lastFrameAt: string | null
  vncEndpoint: VncEndpointInfo | null
}

// ---------------------------------------------------------------------------
// Screenshot (degraded mode)
// ---------------------------------------------------------------------------

export interface ScreenshotRequest {
  /** Image format. Default "jpeg". */
  format?: "jpeg" | "png"
  /** JPEG quality (1–100). Default 70. */
  quality?: number
  /** Capture full page or just viewport. Default false. */
  fullPage?: boolean
}

export interface ScreenshotResult {
  agentId: string
  /** base64-encoded image data. */
  data: string
  format: "jpeg" | "png"
  width: number
  height: number
  timestamp: string
  /** Page URL at capture time. */
  url: string
  title: string
}

// ---------------------------------------------------------------------------
// Multi-tab awareness
// ---------------------------------------------------------------------------

export interface TabInfo {
  /** Page index within the browser context. */
  index: number
  url: string
  title: string
  /** Whether this is the currently active (focused) page. */
  active: boolean
}

export interface TabListResult {
  agentId: string
  tabs: TabInfo[]
  timestamp: string
}

// ---------------------------------------------------------------------------
// Trace recording (Playwright Trace Viewer)
// ---------------------------------------------------------------------------

export type TraceStatus = "idle" | "recording" | "stopping"

export interface TraceState {
  agentId: string
  status: TraceStatus
  /** When recording started (ISO 8601), null if idle. */
  startedAt: string | null
  /** Options used for current/last recording. */
  options: TraceRecordingOptions | null
}

export interface TraceRecordingOptions {
  /** Capture DOM snapshots. Default true. */
  snapshots?: boolean
  /** Capture screenshots. Default true. */
  screenshots?: boolean
  /** Capture network activity. Default true. */
  network?: boolean
  /** Capture console messages. Default true. */
  console?: boolean
}

export interface TraceDownloadResult {
  agentId: string
  /** Absolute path to the .zip trace file. */
  filePath: string
  /** Size in bytes. */
  sizeBytes: number
  /** Duration of the recording in milliseconds. */
  durationMs: number
  timestamp: string
}

// ---------------------------------------------------------------------------
// Annotation / Interaction forwarding
// ---------------------------------------------------------------------------

export interface AnnotationEvent {
  /** Coordinate-based click from the dashboard overlay. */
  type: "click" | "hover" | "scroll" | "highlight"
  /** X coordinate relative to viewport. */
  x: number
  /** Y coordinate relative to viewport. */
  y: number
  /** Optional element selector hint (if dashboard can resolve it). */
  selector?: string
  /** Free-form instruction text attached to the annotation. */
  prompt?: string
  /** Scroll delta for scroll events. */
  scrollDelta?: number
}

export interface AnnotationResult {
  agentId: string
  annotationId: string
  /** Whether the event was forwarded to the agent. */
  forwarded: boolean
  timestamp: string
}

// ---------------------------------------------------------------------------
// SSE event types for browser observation
// ---------------------------------------------------------------------------

export type BrowserObservationEventType =
  | "browser:screenshot"
  | "browser:tabs"
  | "browser:trace:state"
  | "browser:annotation:ack"

// ---------------------------------------------------------------------------
// Observation service configuration
// ---------------------------------------------------------------------------

export interface ObservationServiceConfig {
  /** CDP sidecar host. Default "127.0.0.1". */
  cdpHost?: string
  /** CDP sidecar port. Default 9222. */
  cdpPort?: number
  /** Websockify port on the sidecar. Default 6080. */
  websockifyPort?: number
  /** Raw VNC port on the sidecar. Default 5900. */
  vncPort?: number
  /** Directory for storing trace files. Default "/workspace/traces". */
  traceDir?: string
  /** Directory for storing screenshots. Default "/workspace/browser". */
  assetDir?: string
}
