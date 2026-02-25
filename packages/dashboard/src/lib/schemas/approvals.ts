import { z } from "zod"

import { PaginationSchema } from "./common"

export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"])

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  agentId: z.string().optional(),
  status: ApprovalStatusSchema,
  actionType: z.string(),
  actionSummary: z.string(),
  actionDetail: z.record(z.string(), z.unknown()).optional(),
  approverUserAccountId: z.string().optional(),
  requestedAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  expiresAt: z.string(),
  decision: z.enum(["APPROVED", "REJECTED"]).optional(),
  reason: z.string().optional(),
})

export const ApprovalListResponseSchema = z.object({
  approvals: z.array(ApprovalRequestSchema),
  pagination: PaginationSchema,
})

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
