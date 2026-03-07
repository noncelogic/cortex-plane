/**
 * Observability types — shared interfaces for the event emitter and its
 * consumers (routes, workers, tests).
 */

import type { AgentEventType } from "../db/types.js"

// ---------------------------------------------------------------------------
// Emit input
// ---------------------------------------------------------------------------

export interface AgentEventInput {
  agentId: string
  sessionId?: string | null
  jobId?: string | null
  parentEventId?: string | null
  eventType: AgentEventType | (string & {})
  payload?: Record<string, unknown>
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  durationMs?: number | null
  model?: string | null
  toolRef?: string | null
  actor?: "agent" | "operator" | "system" | null
}

// ---------------------------------------------------------------------------
// Query filters
// ---------------------------------------------------------------------------

export interface EventQueryFilters {
  agentId?: string
  sessionId?: string
  jobId?: string
  eventTypes?: AgentEventType[]
  actor?: string
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Query result
// ---------------------------------------------------------------------------

export interface EventQueryResult {
  events: AgentEventRow[]
  total: number
}

export interface AgentEventRow {
  id: string
  agentId: string
  sessionId: string | null
  jobId: string | null
  parentEventId: string | null
  eventType: string
  payload: Record<string, unknown>
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  durationMs: number | null
  model: string | null
  toolRef: string | null
  actor: string | null
  createdAt: Date
}
