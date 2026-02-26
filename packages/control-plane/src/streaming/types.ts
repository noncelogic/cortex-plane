/**
 * SSE streaming types for agent output and steering.
 *
 * Events flow: Agent → OutputEvent → SSEConnection → Client
 * Steering:    Client → POST /steer → AgentLifecycleManager → Agent
 */

import type { OutputEvent } from "@cortex/shared/backends"

// ---------------------------------------------------------------------------
// SSE Event Types
// ---------------------------------------------------------------------------

/** SSE event names sent to clients. */
export type SSEEventType =
  | "agent:output"
  | "agent:state"
  | "agent:error"
  | "agent:complete"
  | "steer:ack"
  | "heartbeat"
  | "approval:created"
  | "approval:decided"
  | "approval:expired"
  | "browser:screenshot"
  | "browser:tabs"
  | "browser:tab:event"
  | "browser:trace:state"
  | "browser:annotation:ack"
  | "browser:steer:action"
  | "browser:auth:handoff"
  | "browser:screenshot:frame"

/** A serialized SSE event with an ID for replay support. */
export interface SSEEvent {
  /** Monotonically increasing event ID for replay on reconnect. */
  id: string
  /** SSE event type (used in the `event:` field). */
  event: SSEEventType
  /** JSON-serialized payload. */
  data: string
}

// ---------------------------------------------------------------------------
// Agent Output Payloads
// ---------------------------------------------------------------------------

export interface AgentOutputPayload {
  agentId: string
  timestamp: string
  output: OutputEvent
}

export interface AgentStatePayload {
  agentId: string
  timestamp: string
  state: string
  reason?: string
}

export interface AgentErrorPayload {
  agentId: string
  timestamp: string
  message: string
  code?: string
}

export interface AgentCompletePayload {
  agentId: string
  timestamp: string
  summary?: string
}

// ---------------------------------------------------------------------------
// Steering Types
// ---------------------------------------------------------------------------

export interface SteerRequest {
  /** Natural language instruction to inject. */
  message: string
  /** Optional priority hint. Higher = more urgent. */
  priority?: "normal" | "high"
}

export interface SteerAckPayload {
  agentId: string
  steerMessageId: string
  timestamp: string
  status: "accepted" | "rejected"
  reason?: string
}

// ---------------------------------------------------------------------------
// Approval Event Payloads
// ---------------------------------------------------------------------------

export interface ApprovalCreatedPayload {
  approvalRequestId: string
  jobId: string
  agentId: string
  actionSummary: string
  actionType: string
  expiresAt: string
  timestamp: string
}

export interface ApprovalDecidedPayload {
  approvalRequestId: string
  jobId: string
  decision: string
  decidedBy: string
  timestamp: string
}

export interface ApprovalExpiredPayload {
  approvalRequestId: string
  jobId: string
  expiredAt: string
  timestamp: string
}

// ---------------------------------------------------------------------------
// Connection Types
// ---------------------------------------------------------------------------

export interface SSEConnectionInfo {
  connectionId: string
  agentId: string
  connectedAt: Date
  lastEventId: string | null
  /** Number of events sent on this connection. */
  eventCount: number
}

// ---------------------------------------------------------------------------
// Buffer Configuration
// ---------------------------------------------------------------------------

export interface BufferConfig {
  /** Max events to buffer per connection before dropping. */
  maxBufferSize: number
  /** Max events to retain for replay on reconnect. */
  maxReplayBufferSize: number
  /** Interval (ms) between heartbeat pings. */
  heartbeatIntervalMs: number
}

export const DEFAULT_BUFFER_CONFIG: BufferConfig = {
  maxBufferSize: 1000,
  maxReplayBufferSize: 5000,
  heartbeatIntervalMs: 15_000,
}
