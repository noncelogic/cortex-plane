"use client"

import { useMemo } from "react"
import { z } from "zod"

import { resolveSSEUrl, type SSEConnectionStatus, type SSEEvent } from "@/lib/sse-client"

import { useSSE } from "./use-sse"

// ---------------------------------------------------------------------------
// Typed payloads — validated via Zod at the SSE boundary
// ---------------------------------------------------------------------------

const AgentOutputPayloadSchema = z.object({
  agentId: z.string(),
  timestamp: z.string(),
  output: z
    .object({
      type: z.string(),
      content: z.string(),
    })
    .passthrough(),
})

const AgentStatePayloadSchema = z.object({
  agentId: z.string(),
  timestamp: z.string(),
  state: z.string(),
  reason: z.string().optional(),
})

const AgentErrorPayloadSchema = z.object({
  agentId: z.string(),
  timestamp: z.string(),
  message: z.string(),
  code: z.string().optional(),
})

const AgentCompletePayloadSchema = z.object({
  agentId: z.string(),
  timestamp: z.string(),
  summary: z.string().optional(),
})

const SteerInjectedPayloadSchema = z.object({
  agentId: z.string(),
  steerEventId: z.string(),
  operatorUserId: z.string(),
  instruction: z.string(),
  priority: z.enum(["normal", "urgent"]),
  timestamp: z.string(),
})

const SteerAcknowledgedPayloadSchema = z.object({
  agentId: z.string(),
  steerEventId: z.string(),
  incorporatedAtTurn: z.number(),
  timestamp: z.string(),
})

const SSE_SCHEMAS: Record<string, z.ZodType> = {
  "agent:output": AgentOutputPayloadSchema,
  "agent:state": AgentStatePayloadSchema,
  "agent:error": AgentErrorPayloadSchema,
  "agent:complete": AgentCompletePayloadSchema,
  "steer:injected": SteerInjectedPayloadSchema,
  "steer:acknowledged": SteerAcknowledgedPayloadSchema,
}

export type AgentOutputPayload = z.infer<typeof AgentOutputPayloadSchema>
export type AgentStatePayload = z.infer<typeof AgentStatePayloadSchema>
export type AgentErrorPayload = z.infer<typeof AgentErrorPayloadSchema>
export type AgentCompletePayload = z.infer<typeof AgentCompletePayloadSchema>
export type SteerInjectedPayload = z.infer<typeof SteerInjectedPayloadSchema>
export type SteerAcknowledgedPayload = z.infer<typeof SteerAcknowledgedPayloadSchema>

export type AgentEventPayload =
  | { type: "agent:output"; data: AgentOutputPayload }
  | { type: "agent:state"; data: AgentStatePayload }
  | { type: "agent:error"; data: AgentErrorPayload }
  | { type: "agent:complete"; data: AgentCompletePayload }
  | { type: "steer:injected"; data: SteerInjectedPayload }
  | { type: "steer:acknowledged"; data: SteerAcknowledgedPayload }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const AGENT_EVENT_TYPES = [
  "agent:output",
  "agent:state",
  "agent:error",
  "agent:complete",
  "steer:injected",
  "steer:acknowledged",
] as const

export function parseAgentStreamEvents(rawEvents: SSEEvent[]): AgentEventPayload[] {
  return rawEvents.reduce<AgentEventPayload[]>((acc, e: SSEEvent) => {
    try {
      const raw: unknown = JSON.parse(e.data)
      const schema = SSE_SCHEMAS[e.type]
      if (!schema) return acc
      const data = schema.parse(raw)
      acc.push({ type: e.type, data } as unknown as AgentEventPayload)
    } catch {
      // skip events that fail JSON parse or schema validation
    }
    return acc
  }, [])
}

interface UseAgentStreamOptions {
  /** Max events to keep in the replay buffer (default: 500) */
  maxEvents?: number
}

interface UseAgentStreamReturn {
  /** Typed, parsed events (most recent last) */
  events: AgentEventPayload[]
  /** Raw SSE events for low-level access */
  rawEvents: SSEEvent[]
  /** Whether the stream is connected */
  connected: boolean
  /** Tri-state connection status */
  status: SSEConnectionStatus
}

export function useAgentStream(
  agentId: string,
  options?: UseAgentStreamOptions,
): UseAgentStreamReturn {
  const url = resolveSSEUrl(`/api/agents/${agentId}/stream`)

  const {
    events: rawEvents,
    connected,
    status,
  } = useSSE({
    url,
    eventTypes: [...AGENT_EVENT_TYPES],
    maxEvents: options?.maxEvents ?? 500,
  })

  const events = useMemo(() => parseAgentStreamEvents(rawEvents), [rawEvents])

  return { events, rawEvents, connected, status }
}
