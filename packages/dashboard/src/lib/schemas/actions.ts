import { z } from "zod"

// ---------------------------------------------------------------------------
// Agent action responses
// ---------------------------------------------------------------------------

export const SteerResponseSchema = z.object({
  steerMessageId: z.string(),
  status: z.literal("accepted"),
  agentId: z.string(),
  priority: z.enum(["normal", "high"]),
})

export const PauseResponseSchema = z.object({
  agentId: z.string(),
  status: z.literal("pausing"),
})

export const ResumeResponseSchema = z.object({
  agentId: z.string(),
  status: z.literal("resuming"),
  fromCheckpoint: z.string().optional(),
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
  approvalRequestId: z.string(),
  decision: z.string(),
  decidedAt: z.string(),
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
  syncId: z.string(),
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
  contentId: z.string(),
  status: z.literal("published"),
  publishedAt: z.string(),
})

export const ArchiveContentResponseSchema = z.object({
  contentId: z.string(),
  status: z.literal("archived"),
})
