export type JobStatus =
  | "PENDING"
  | "SCHEDULED"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "RETRYING"
  | "DEAD_LETTER"

export type AgentStatus = "ACTIVE" | "DISABLED" | "ARCHIVED"

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"

// ---------------------------------------------------------------------------
// Approval Gate Types
// ---------------------------------------------------------------------------

/** Default token TTL: 24 hours */
export const DEFAULT_APPROVAL_TTL_SECONDS = 86_400

/** Maximum allowed TTL: 7 days */
export const MAX_APPROVAL_TTL_SECONDS = 604_800

/** Approval token prefix for greppability */
export const APPROVAL_TOKEN_PREFIX = "cortex_apr"

/** Current token format version */
export const APPROVAL_TOKEN_VERSION = 1

/** Audit event types for the approval_audit_log table */
export type ApprovalAuditEventType =
  | "notification_sent"
  | "notification_failed"
  | "reminder_sent"
  | "escalation_sent"
  | "unauthorized_attempt"
  | "decision_conflict"
  | "request_created"
  | "request_decided"
  | "request_expired"

/** Notification channel record stored in approval_request.notification_channels */
export interface ApprovalNotificationRecord {
  channel_type: string
  channel_user_id: string
  chat_id: string
  notification_sent_at: string
  message_id: string | null
}

/** Configuration for approval behavior (from agent.skill_config.approval) */
export interface ApprovalConfig {
  token_ttl_seconds: number
  max_ttl_seconds: number
}

/** Request to create an approval gate */
export interface CreateApprovalRequest {
  jobId: string
  agentId: string
  actionType: string
  actionSummary: string
  actionDetail: Record<string, unknown>
  approverUserAccountId?: string | null
  ttlSeconds?: number
}

/** Result of processing an approval decision */
export interface ApprovalDecisionResult {
  success: boolean
  error?: string
  approvalRequestId?: string
  decision?: ApprovalStatus
}

/** SSE event payload for approval events */
export interface ApprovalEventPayload {
  approvalRequestId: string
  jobId: string
  event: "created" | "decided" | "expired"
  decision?: ApprovalStatus
  decidedBy?: string
  actionSummary?: string
  timestamp: string
}
