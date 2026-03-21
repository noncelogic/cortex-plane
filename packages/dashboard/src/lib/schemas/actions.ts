import { z } from "zod"

// ---------------------------------------------------------------------------
// Agent action responses
// ---------------------------------------------------------------------------

export const SteerResponseSchema = z.object({
  steerEventId: z.string(),
  acknowledged: z.boolean(),
  incorporatedAtTurn: z.number().int().min(1).optional(),
})

export const PauseResponseSchema = z.object({
  agent_id: z.string(),
  status: z.literal("pausing"),
})

export const ResumeResponseSchema = z.object({
  agent_id: z.string(),
  status: z.literal("resuming"),
  from_checkpoint: z.string().optional(),
})

export const CreateAgentJobResponseSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  status: z.string(),
})

export type CreateAgentJobResponse = z.infer<typeof CreateAgentJobResponseSchema>

// ---------------------------------------------------------------------------
// Approval action responses
// ---------------------------------------------------------------------------

export const ApprovalDecisionResponseSchema = z.object({
  approval_request_id: z.string(),
  decision: z.string(),
  decided_at: z.string(),
})

// ---------------------------------------------------------------------------
// Job action responses
// ---------------------------------------------------------------------------

export const RetryJobResponseSchema = z.object({
  jobId: z.string(),
  status: z.literal("retrying"),
})

// ---------------------------------------------------------------------------
// Memory action responses
// ---------------------------------------------------------------------------

export const SyncMemoryResponseSchema = z.object({
  sync_id: z.string(),
  status: z.string(),
  stats: z.object({
    upserted: z.number(),
    deleted: z.number(),
    unchanged: z.number(),
  }),
})

// ---------------------------------------------------------------------------
// Content action responses
// ---------------------------------------------------------------------------

export const PublishContentResponseSchema = z.object({
  content_id: z.string(),
  status: z.literal("published"),
  published_at: z.string(),
})

export const ArchiveContentResponseSchema = z.object({
  content_id: z.string(),
  status: z.literal("archived"),
})
