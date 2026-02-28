import { z } from "zod"

import { PaginationSchema } from "./common"

export const AgentStatusSchema = z.enum(["ACTIVE", "DISABLED", "ARCHIVED"])

export const AgentLifecycleStateSchema = z.enum([
  "BOOTING",
  "HYDRATING",
  "READY",
  "EXECUTING",
  "DRAINING",
  "TERMINATED",
])

export const CheckpointSchema = z.object({
  job_id: z.string(),
  saved_at: z.string(),
  crc32: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
})

export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  description: z.string().optional().nullable(),
  status: AgentStatusSchema,
  lifecycle_state: AgentLifecycleStateSchema.optional(),
  current_job_id: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string().optional().nullable(),
})

export const AgentDetailSchema = AgentSummarySchema.extend({
  model_config: z.record(z.string(), z.unknown()).optional().nullable(),
  skill_config: z.record(z.string(), z.unknown()).optional().nullable(),
  resource_limits: z.record(z.string(), z.unknown()).optional().nullable(),
  channel_permissions: z.record(z.string(), z.unknown()).optional().nullable(),
  checkpoint: CheckpointSchema.optional().nullable(),
})

/**
 * Accept both the current server shape ({agents, count}) and the full
 * pagination shape ({agents, pagination}). Normalize to {agents, pagination}.
 */
export const AgentListResponseSchema = z
  .object({
    agents: z.array(AgentSummarySchema),
    pagination: PaginationSchema.optional(),
    count: z.number().optional(),
  })
  .transform((data) => {
    if (data.pagination) {
      return { agents: data.agents, pagination: data.pagination }
    }
    const total = data.count ?? data.agents.length
    return {
      agents: data.agents,
      pagination: {
        total,
        limit: total,
        offset: 0,
        has_more: false,
      },
    }
  })

export type AgentStatus = z.infer<typeof AgentStatusSchema>
export type AgentLifecycleState = z.infer<typeof AgentLifecycleStateSchema>
export type Checkpoint = z.infer<typeof CheckpointSchema>
export type AgentSummary = z.infer<typeof AgentSummarySchema>
export type AgentDetail = z.infer<typeof AgentDetailSchema>
