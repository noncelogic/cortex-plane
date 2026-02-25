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
  jobId: z.string(),
  savedAt: z.string(),
  crc32: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
})

export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  description: z.string().optional(),
  status: AgentStatusSchema,
  lifecycleState: AgentLifecycleStateSchema,
  currentJobId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})

export const AgentDetailSchema = AgentSummarySchema.extend({
  modelConfig: z.record(z.string(), z.unknown()).optional(),
  skillConfig: z.record(z.string(), z.unknown()).optional(),
  resourceLimits: z.record(z.string(), z.unknown()).optional(),
  channelPermissions: z.record(z.string(), z.unknown()).optional(),
  checkpoint: CheckpointSchema.optional(),
})

export const AgentListResponseSchema = z.object({
  agents: z.array(AgentSummarySchema),
  pagination: PaginationSchema,
})

export type AgentStatus = z.infer<typeof AgentStatusSchema>
export type AgentLifecycleState = z.infer<typeof AgentLifecycleStateSchema>
export type Checkpoint = z.infer<typeof CheckpointSchema>
export type AgentSummary = z.infer<typeof AgentSummarySchema>
export type AgentDetail = z.infer<typeof AgentDetailSchema>
