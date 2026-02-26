/**
 * Browser Session Model
 *
 * Defines the session, tab, and event types for browser orchestration.
 * Sessions track the lifecycle of a browser context attached to an agent.
 */

// ---------------------------------------------------------------------------
// Session Lifecycle
// ---------------------------------------------------------------------------

export type BrowserSessionStatus = "creating" | "active" | "paused" | "terminated"

export interface BrowserSession {
  id: string
  agentId: string
  tabs: BrowserTab[]
  activeTabId: string | null
  status: BrowserSessionStatus
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Tab Model
// ---------------------------------------------------------------------------

export type BrowserTabStatus = "loading" | "complete" | "error"

export interface BrowserTab {
  id: string
  url: string
  title: string
  favicon: string | null
  status: BrowserTabStatus
}

// ---------------------------------------------------------------------------
// Tab Events
// ---------------------------------------------------------------------------

export type TabEventType = "tab_created" | "tab_closed" | "tab_navigated" | "tab_activated"

export interface TabEvent {
  type: TabEventType
  sessionId: string
  tabId: string
  timestamp: string
  /** URL after the event (for navigated/created). */
  url?: string
  /** Title after the event (for navigated/created). */
  title?: string
}

// ---------------------------------------------------------------------------
// Annotation Steering Types
// ---------------------------------------------------------------------------

export type AnnotationType = "click" | "type" | "scroll" | "highlight" | "select"

export interface AnnotationPayload {
  type: AnnotationType
  coordinates: { x: number; y: number }
  selector?: string
  text?: string
  metadata: Record<string, unknown>
}

export interface SteerAction {
  actionType: string
  target: string
  parameters: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Auth Handoff Types
// ---------------------------------------------------------------------------

export interface AuthHandoffCookie {
  name: string
  value: string
  domain: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: "Strict" | "Lax" | "None"
  expires?: number
}

export interface AuthHandoffRequest {
  agentId: string
  targetUrl: string
  cookies?: AuthHandoffCookie[]
  localStorage?: Record<string, string>
  sessionToken?: string
}

export interface AuthHandoffResult {
  success: boolean
  injectedAt: string
  targetUrl: string
  expiresAt?: string
}

// ---------------------------------------------------------------------------
// Trace Metadata
// ---------------------------------------------------------------------------

export interface TraceMetadata {
  traceId: string
  jobId: string
  agentId: string
  startedAt: string
  stoppedAt: string | null
  sizeBytes: number
  downloadUrl: string
}

// ---------------------------------------------------------------------------
// Screenshot Stream Types
// ---------------------------------------------------------------------------

export interface ScreenshotStreamConfig {
  intervalMs: number
  format: "jpeg" | "png"
  quality: number
}

export interface ScreenshotFrame {
  agentId: string
  data: string
  format: "jpeg" | "png"
  width: number
  height: number
  timestamp: string
  url: string
  changed: boolean
}
