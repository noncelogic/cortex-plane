import { z } from "zod"

import { PaginationSchema } from "./common"

export const JobStatusSchema = z.enum([
  "PENDING",
  "SCHEDULED",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "RETRYING",
  "DEAD_LETTER",
])

export const JobSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullish(),
  status: JobStatusSchema,
  type: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  errorCategory: z.string().nullish(),
  costUsd: z.number().nullish(),
})

export const JobStepSchema = z.object({
  name: z.string(),
  status: z.enum(["COMPLETED", "FAILED", "RUNNING", "PENDING"]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  worker: z.string().optional(),
  error: z.string().optional(),
})

export const JobLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["INFO", "WARN", "ERR", "DEBUG"]),
  message: z.string(),
})

export const FailureReasonSchema = z.object({
  message: z.string(),
  category: z.string().optional(),
})

export const TokenUsageSchema = z.object({
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number().optional(),
  llmCallCount: z.number(),
  toolCallCount: z.number(),
})

export const JobDetailSchema = JobSummarySchema.extend({
  agentName: z.string().nullish(),
  durationMs: z.number().nullish(),
  startedAt: z.string().nullish(),
  attempt: z.number().nullish(),
  maxAttempts: z.number().nullish(),
  failureReason: FailureReasonSchema.nullish(),
  tokenUsage: TokenUsageSchema.nullish(),
  steps: z.array(JobStepSchema),
  logs: z.array(JobLogEntrySchema),
})

export const JobListResponseSchema = z.object({
  jobs: z.array(JobSummarySchema),
  pagination: PaginationSchema,
})

export const DashboardSummarySchema = z.object({
  totalAgents: z.number(),
  activeJobs: z.number(),
  pendingApprovals: z.number(),
  memoryRecords: z.number(),
})

export const DashboardActivitySchema = z.object({
  activity: z.array(JobSummarySchema),
})

export type JobStatus = z.infer<typeof JobStatusSchema>
export type JobSummary = z.infer<typeof JobSummarySchema>
export type JobStep = z.infer<typeof JobStepSchema>
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>
export type FailureReason = z.infer<typeof FailureReasonSchema>
export type TokenUsage = z.infer<typeof TokenUsageSchema>
export type JobDetail = z.infer<typeof JobDetailSchema>
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>
export type DashboardActivity = z.infer<typeof DashboardActivitySchema>
