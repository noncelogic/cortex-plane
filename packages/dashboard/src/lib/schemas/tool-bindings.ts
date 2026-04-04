import { z } from "zod"

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ToolApprovalPolicySchema = z.enum(["auto", "always_approve", "conditional"])

// ---------------------------------------------------------------------------
// Tool Binding
// ---------------------------------------------------------------------------

export const ToolBindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  toolRef: z.string(),
  approvalPolicy: ToolApprovalPolicySchema,
  approvalCondition: z.record(z.string(), z.unknown()).nullable(),
  rateLimit: z.record(z.string(), z.unknown()).nullable(),
  costBudget: z.record(z.string(), z.unknown()).nullable(),
  dataScope: z.record(z.string(), z.unknown()).nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ToolBindingListResponseSchema = z.object({
  bindings: z.array(ToolBindingSchema),
  total: z.number(),
})

// ---------------------------------------------------------------------------
// Bulk Bind
// ---------------------------------------------------------------------------

export const BulkBindSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  toolRef: z.string(),
  approvalPolicy: ToolApprovalPolicySchema,
  enabled: z.boolean(),
  createdAt: z.string(),
})

export const BulkBindResponseSchema = z.object({
  created: z.number(),
  bindings: z.array(BulkBindSummarySchema),
})

// ---------------------------------------------------------------------------
// Effective Tools
// ---------------------------------------------------------------------------

export const EffectiveToolSchema = z.object({
  toolRef: z.string(),
  runtimeName: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  bindingId: z.string(),
  approvalPolicy: ToolApprovalPolicySchema,
  approvalCondition: z.record(z.string(), z.unknown()).nullable(),
  rateLimit: z.record(z.string(), z.unknown()).nullable(),
  costBudget: z.record(z.string(), z.unknown()).nullable(),
  dataScope: z.record(z.string(), z.unknown()).nullable(),
  source: z.object({
    kind: z.enum(["builtin", "mcp", "webhook", "unknown"]),
  }),
})

export const EffectiveToolsResponseSchema = z.object({
  tools: z.array(EffectiveToolSchema),
  assembledAt: z.string(),
})

// ---------------------------------------------------------------------------
// Capability Audit
// ---------------------------------------------------------------------------

export const CapabilityAuditEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  toolRef: z.string(),
  eventType: z.string(),
  actorUserId: z.string().nullable(),
  jobId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
})

export const CapabilityAuditResponseSchema = z.object({
  entries: z.array(CapabilityAuditEntrySchema),
  total: z.number(),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>
export type ToolBinding = z.infer<typeof ToolBindingSchema>
export type EffectiveTool = z.infer<typeof EffectiveToolSchema>
export type CapabilityAuditEntry = z.infer<typeof CapabilityAuditEntrySchema>
