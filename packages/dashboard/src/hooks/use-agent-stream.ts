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

const SteerAckPayloadSchema = z.object({
  agentId: z.string(),
  steerMessageId: z.string(),
  timestamp: z.string(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
})

const SSE_SCHEMAS: Record<string, z.ZodType> = {
  "agent:output": AgentOutputPayloadSchema,
  "agent:state": AgentStatePayloadSchema,
  "agent:error": AgentErrorPayloadSchema,
  "agent:complete": AgentCompletePayloadSchema,
  "steer:ack": SteerAckPayloadSchema,
}

export type AgentOutputPayload = z.infer<typeof AgentOutputPayloadSchema>
export type AgentStatePayload = z.infer<typeof AgentStatePayloadSchema>
export type AgentErrorPayload = z.infer<typeof AgentErrorPayloadSchema>
export type AgentCompletePayload = z.infer<typeof AgentCompletePayloadSchema>
export type SteerAckPayload = z.infer<typeof SteerAckPayloadSchema>

export type AgentEventPayload =
  | { type: "agent:output"; data: AgentOutputPayload }
  | { type: "agent:state"; data: AgentStatePayload }
  | { type: "agent:error"; data: AgentErrorPayload }
  | { type: "agent:complete"; data: AgentCompletePayload }
  | { type: "steer:ack"; data: SteerAckPayload }

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const AGENT_EVENT_TYPES = [
  "agent:output",
  "agent:state",
  "agent:error",
  "agent:complete",
  "steer:ack",
] as const

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

  const events = useMemo(
    () =>
      rawEvents.reduce<AgentEventPayload[]>((acc, e: SSEEvent) => {
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
      }, []),
    [rawEvents],
  )

  return { events, rawEvents, connected, status }
}
