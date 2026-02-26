import type { AgentStatus, ApprovalStatus, JobStatus } from "@cortex/shared"
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely"

// ---------------------------------------------------------------------------
// Enum: user_role
// ---------------------------------------------------------------------------
export type UserRole = "operator" | "approver" | "admin"

// ---------------------------------------------------------------------------
// Enum: credential_type
// ---------------------------------------------------------------------------
export type CredentialType = "oauth" | "api_key"

// ---------------------------------------------------------------------------
// Enum: credential_status
// ---------------------------------------------------------------------------
export type CredentialStatus = "active" | "expired" | "revoked" | "error"

// ---------------------------------------------------------------------------
// Table: agent
// ---------------------------------------------------------------------------
export interface AgentTable {
  id: Generated<string>
  name: string
  slug: string
  role: string
  description: string | null
  model_config: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  skill_config: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  resource_limits: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  channel_permissions: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  status: ColumnType<AgentStatus, AgentStatus | undefined, AgentStatus>
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, never>
}

export type Agent = Selectable<AgentTable>
export type NewAgent = Insertable<AgentTable>
export type AgentUpdate = Updateable<AgentTable>

// ---------------------------------------------------------------------------
// Table: user_account
// ---------------------------------------------------------------------------
export interface UserAccountTable {
  id: Generated<string>
  display_name: string | null
  email: string | null
  avatar_url: string | null
  role: ColumnType<UserRole, UserRole | undefined, UserRole>
  oauth_provider: string | null
  oauth_provider_id: string | null
  encryption_key_enc: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type UserAccount = Selectable<UserAccountTable>
export type NewUserAccount = Insertable<UserAccountTable>
export type UserAccountUpdate = Updateable<UserAccountTable>

// ---------------------------------------------------------------------------
// Table: channel_mapping
// ---------------------------------------------------------------------------
export interface ChannelMappingTable {
  id: Generated<string>
  user_account_id: string
  channel_type: string
  channel_user_id: string
  metadata: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  created_at: ColumnType<Date, Date | undefined, never>
}

export type ChannelMapping = Selectable<ChannelMappingTable>
export type NewChannelMapping = Insertable<ChannelMappingTable>

// ---------------------------------------------------------------------------
// Table: session
// ---------------------------------------------------------------------------
export interface SessionTable {
  id: Generated<string>
  agent_id: string
  user_account_id: string
  status: ColumnType<string, string | undefined, string>
  metadata: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, never>
}

export type Session = Selectable<SessionTable>
export type NewSession = Insertable<SessionTable>
export type SessionUpdate = Updateable<SessionTable>

// ---------------------------------------------------------------------------
// Table: job
// ---------------------------------------------------------------------------
export interface JobTable {
  id: Generated<string>
  agent_id: string
  session_id: string | null
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>
  priority: ColumnType<number, number | undefined, number>
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  checkpoint: Record<string, unknown> | null
  checkpoint_crc: number | null
  error: Record<string, unknown> | null
  attempt: ColumnType<number, number | undefined, number>
  max_attempts: ColumnType<number, number | undefined, number>
  timeout_seconds: ColumnType<number, number | undefined, number>
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, never>
  started_at: Date | null
  completed_at: Date | null
  heartbeat_at: Date | null
  approval_expires_at: Date | null
}

export type Job = Selectable<JobTable>
export type NewJob = Insertable<JobTable>
export type JobUpdate = Updateable<JobTable>

// ---------------------------------------------------------------------------
// Table: approval_request
// ---------------------------------------------------------------------------
export interface ApprovalRequestTable {
  id: Generated<string>
  job_id: string
  action_type: string
  action_detail: Record<string, unknown>
  token_hash: string
  status: ColumnType<ApprovalStatus, ApprovalStatus | undefined, ApprovalStatus>
  requested_at: ColumnType<Date, Date | undefined, never>
  decided_at: Date | null
  decided_by: string | null
  expires_at: Date
  decision_note: string | null
  requested_by_agent_id: string | null
  approver_user_account_id: string | null
  notification_channels: ColumnType<
    Record<string, unknown>[],
    Record<string, unknown>[] | undefined,
    Record<string, unknown>[]
  >
  action_summary: string | null
}

export type ApprovalRequest = Selectable<ApprovalRequestTable>
export type NewApprovalRequest = Insertable<ApprovalRequestTable>
export type ApprovalRequestUpdate = Updateable<ApprovalRequestTable>

// ---------------------------------------------------------------------------
// Table: approval_audit_log
// ---------------------------------------------------------------------------
export interface ApprovalAuditLogTable {
  id: Generated<string>
  approval_request_id: string | null
  job_id: string | null
  event_type: string
  actor_user_id: string | null
  actor_channel: string | null
  details: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  created_at: ColumnType<Date, Date | undefined, never>
}

export type ApprovalAuditLog = Selectable<ApprovalAuditLogTable>
export type NewApprovalAuditLog = Insertable<ApprovalAuditLogTable>

// ---------------------------------------------------------------------------
// Table: dashboard_session
// ---------------------------------------------------------------------------
export interface DashboardSessionTable {
  id: Generated<string>
  user_account_id: string
  csrf_token: string
  expires_at: Date
  refresh_token: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  last_active_at: ColumnType<Date, Date | undefined, Date>
}

export type DashboardSession = Selectable<DashboardSessionTable>
export type NewDashboardSession = Insertable<DashboardSessionTable>

// ---------------------------------------------------------------------------
// Table: provider_credential
// ---------------------------------------------------------------------------
export interface ProviderCredentialTable {
  id: Generated<string>
  user_account_id: string
  provider: string
  credential_type: CredentialType
  access_token_enc: string | null
  refresh_token_enc: string | null
  api_key_enc: string | null
  token_expires_at: Date | null
  scopes: string[] | null
  account_id: string | null
  display_label: string | null
  status: ColumnType<CredentialStatus, CredentialStatus | undefined, CredentialStatus>
  last_used_at: Date | null
  last_refresh_at: Date | null
  error_count: ColumnType<number, number | undefined, number>
  last_error: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type ProviderCredential = Selectable<ProviderCredentialTable>
export type NewProviderCredential = Insertable<ProviderCredentialTable>
export type ProviderCredentialUpdate = Updateable<ProviderCredentialTable>

// ---------------------------------------------------------------------------
// Table: credential_audit_log
// ---------------------------------------------------------------------------
export interface CredentialAuditLogTable {
  id: Generated<string>
  user_account_id: string | null
  provider_credential_id: string | null
  event_type: string
  provider: string | null
  details: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  ip_address: string | null
  created_at: ColumnType<Date, Date | undefined, never>
}

export type CredentialAuditLog = Selectable<CredentialAuditLogTable>
export type NewCredentialAuditLog = Insertable<CredentialAuditLogTable>

// ---------------------------------------------------------------------------
// Database interface — register all tables here.
// ---------------------------------------------------------------------------
export interface Database {
  agent: AgentTable
  user_account: UserAccountTable
  channel_mapping: ChannelMappingTable
  session: SessionTable
  job: JobTable
  approval_request: ApprovalRequestTable
  approval_audit_log: ApprovalAuditLogTable
  dashboard_session: DashboardSessionTable
  provider_credential: ProviderCredentialTable
  credential_audit_log: CredentialAuditLogTable
}
