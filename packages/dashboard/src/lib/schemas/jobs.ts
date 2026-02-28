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
  agent_id: z.string(),
  status: JobStatusSchema,
  type: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  completed_at: z.string().optional(),
  error: z.string().optional(),
})

export const JobStepSchema = z.object({
  name: z.string(),
  status: z.enum(["COMPLETED", "FAILED", "RUNNING", "PENDING"]),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  duration_ms: z.number().optional(),
  worker: z.string().optional(),
  error: z.string().optional(),
})

export const JobMetricsSchema = z.object({
  cpu_percent: z.number(),
  memory_mb: z.number(),
  network_in_bytes: z.number(),
  network_out_bytes: z.number(),
  thread_count: z.number(),
})

export const JobLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["INFO", "WARN", "ERR", "DEBUG"]),
  message: z.string(),
})

export const JobDetailSchema = JobSummarySchema.extend({
  agent_name: z.string().optional(),
  agent_version: z.string().optional(),
  duration_ms: z.number().optional(),
  steps: z.array(JobStepSchema),
  metrics: JobMetricsSchema.optional(),
  logs: z.array(JobLogEntrySchema),
})

export const JobListResponseSchema = z.object({
  jobs: z.array(JobSummarySchema),
  pagination: PaginationSchema,
})

export type JobStatus = z.infer<typeof JobStatusSchema>
export type JobSummary = z.infer<typeof JobSummarySchema>
export type JobStep = z.infer<typeof JobStepSchema>
export type JobMetrics = z.infer<typeof JobMetricsSchema>
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>
export type JobDetail = z.infer<typeof JobDetailSchema>
