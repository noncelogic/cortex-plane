import { z } from "zod"

import { PaginationSchema } from "./common"

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"])

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  agent_id: z.string().optional(),
  status: ApprovalStatusSchema,
  action_type: z.string(),
  action_summary: z.string(),
  action_detail: z.record(z.string(), z.unknown()).optional(),
  approver_user_account_id: z.string().optional(),
  requested_at: z.string(),
  decided_at: z.string().optional(),
  decided_by: z.string().optional(),
  expires_at: z.string(),
  decision: z.enum(["APPROVED", "REJECTED"]).optional(),
  reason: z.string().optional(),
})

export const ApprovalListResponseSchema = z.object({
  approvals: z.array(ApprovalRequestSchema),
  pagination: PaginationSchema,
})

export const ApprovalAuditEntrySchema = z.object({
  id: z.string(),
  approval_request_id: z.string().nullable(),
  job_id: z.string().nullable(),
  event_type: z.string(),
  actor_user_id: z.string().nullable(),
  actor_channel: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
})

export const ApprovalAuditResponseSchema = z.object({
  audit: z.array(ApprovalAuditEntrySchema),
})

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type ApprovalAuditEntry = z.infer<typeof ApprovalAuditEntrySchema>
