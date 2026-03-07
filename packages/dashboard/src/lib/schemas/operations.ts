import { z } from "zod"

// ---------------------------------------------------------------------------
// Agent Event Types (matches control-plane AgentEventType enum)
// ---------------------------------------------------------------------------

export const AgentEventTypeSchema = z.enum([
  "llm_call_start",
  "llm_call_end",
  "tool_call_start",
  "tool_call_end",
  "tool_denied",
  "tool_rate_limited",
  "message_received",
  "message_sent",
  "state_transition",
  "circuit_breaker_trip",
  "cost_alert",
  "steer_injected",
  "steer_acknowledged",
  "kill_requested",
  "checkpoint_created",
  "error",
  "session_start",
  "session_end",
])

// ---------------------------------------------------------------------------
// Event row (from GET /agents/:agentId/events)
// ---------------------------------------------------------------------------

export const AgentEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  costUsd: z.number().nullable(),
  toolRef: z.string().nullable(),
  createdAt: z.string(),
})

export const CostSummarySchema = z.object({
  totalUsd: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
})

export const AgentEventListResponseSchema = z.object({
  events: z.array(AgentEventSchema),
  total: z.number(),
  costSummary: CostSummarySchema,
})

// ---------------------------------------------------------------------------
// Cost aggregation (from GET /agents/:agentId/cost)
// ---------------------------------------------------------------------------

export const CostBreakdownEntrySchema = z
  .object({
    costUsd: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
  })
  .passthrough()

export const AgentCostResponseSchema = z.object({
  summary: CostSummarySchema,
  breakdown: z.array(CostBreakdownEntrySchema),
})

// ---------------------------------------------------------------------------
// Kill response (from POST /agents/:agentId/kill)
// ---------------------------------------------------------------------------

export const KillResponseSchema = z.object({
  agentId: z.string(),
  previousState: z.string(),
  cancelledJobId: z.string().nullable(),
  state: z.string(),
  killedAt: z.string(),
})

// ---------------------------------------------------------------------------
// Dry-run response (from POST /agents/:agentId/dry-run)
// ---------------------------------------------------------------------------

export const PlannedActionSchema = z.object({
  type: z.string(),
  toolRef: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export const DryRunResponseSchema = z.object({
  plannedActions: z.array(PlannedActionSchema),
  agentResponse: z.string(),
  tokensUsed: z.object({ in: z.number(), out: z.number() }),
  estimatedCostUsd: z.number(),
})

// ---------------------------------------------------------------------------
// Replay response (from POST /agents/:agentId/replay)
// ---------------------------------------------------------------------------

export const ReplayResponseSchema = z.object({
  replayJobId: z.string(),
  fromCheckpoint: z.string(),
  modifications: z.record(z.string(), z.unknown()).nullable(),
})

// ---------------------------------------------------------------------------
// Quarantine response (from POST /agents/:agentId/quarantine)
// ---------------------------------------------------------------------------

export const QuarantineResponseSchema = z.object({
  agentId: z.string(),
  state: z.literal("QUARANTINED"),
  reason: z.string(),
  quarantinedAt: z.string(),
})

// ---------------------------------------------------------------------------
// Release response (from POST /agents/:agentId/release)
// ---------------------------------------------------------------------------

export const ReleaseResponseSchema = z.object({
  agentId: z.string(),
  state: z.string(),
  releasedAt: z.string(),
})

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type AgentEventType = z.infer<typeof AgentEventTypeSchema>
export type AgentEvent = z.infer<typeof AgentEventSchema>
export type CostSummary = z.infer<typeof CostSummarySchema>
export type AgentEventListResponse = z.infer<typeof AgentEventListResponseSchema>
export type AgentCostResponse = z.infer<typeof AgentCostResponseSchema>
export type CostBreakdownEntry = z.infer<typeof CostBreakdownEntrySchema>
export type KillResponse = z.infer<typeof KillResponseSchema>
export type DryRunResponse = z.infer<typeof DryRunResponseSchema>
export type PlannedAction = z.infer<typeof PlannedActionSchema>
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>
export type QuarantineResponse = z.infer<typeof QuarantineResponseSchema>
export type ReleaseResponse = z.infer<typeof ReleaseResponseSchema>
