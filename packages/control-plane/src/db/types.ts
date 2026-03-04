import type {
  AgentStatus,
  ApprovalStatus,
  FeedbackActionStatus,
  FeedbackActionType,
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackSource,
  FeedbackStatus,
  JobStatus,
  RemediationStatus,
  RiskLevel,
} from "@cortex/shared"
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
// Enum: credential_class
// ---------------------------------------------------------------------------
export type CredentialClass =
  | "llm_provider"
  | "mcp_server"
  | "tool_specific"
  | "user_service"
  | "custom"

// ---------------------------------------------------------------------------
// Enum: mcp_server_status
// ---------------------------------------------------------------------------
export type McpServerStatus = "PENDING" | "ACTIVE" | "DEGRADED" | "ERROR" | "DISABLED"

// ---------------------------------------------------------------------------
// Enum: mcp_transport
// ---------------------------------------------------------------------------
export type McpTransport = "streamable-http" | "stdio"

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
  config: ColumnType<
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
  channel_id: string | null
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
// Table: session_message
// ---------------------------------------------------------------------------
export interface SessionMessageTable {
  id: Generated<string>
  session_id: string
  role: string
  content: string
  created_at: ColumnType<Date, Date | undefined, never>
  metadata: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
}

export type SessionMessage = Selectable<SessionMessageTable>
export type NewSessionMessage = Insertable<SessionMessageTable>

// ---------------------------------------------------------------------------
// Table: memory_extract_session_state
// ---------------------------------------------------------------------------
export interface MemoryExtractSessionStateTable {
  session_id: string
  pending_count: ColumnType<number, number | undefined, number>
  total_count: ColumnType<number, number | undefined, number>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type MemoryExtractSessionState = Selectable<MemoryExtractSessionStateTable>
export type NewMemoryExtractSessionState = Insertable<MemoryExtractSessionStateTable>
export type MemoryExtractSessionStateUpdate = Updateable<MemoryExtractSessionStateTable>

// ---------------------------------------------------------------------------
// Table: memory_extract_message
// ---------------------------------------------------------------------------
export interface MemoryExtractMessageTable {
  id: Generated<string>
  session_id: string
  agent_id: string
  role: string
  content: string
  occurred_at: Date
  extracted_at: Date | null
  created_at: ColumnType<Date, Date | undefined, never>
}

export type MemoryExtractMessage = Selectable<MemoryExtractMessageTable>
export type NewMemoryExtractMessage = Insertable<MemoryExtractMessageTable>
export type MemoryExtractMessageUpdate = Updateable<MemoryExtractMessageTable>

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
  risk_level: ColumnType<RiskLevel, RiskLevel | undefined, RiskLevel>
  resume_payload: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  execution_result: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  resumed_at: Date | null
  executed_at: Date | null
  blast_radius: string | null
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
// Table: feedback_item
// ---------------------------------------------------------------------------
export interface FeedbackItemTable {
  id: Generated<string>
  run_id: string | null
  task_id: string | null
  agent_id: string | null
  source: ColumnType<FeedbackSource, FeedbackSource, FeedbackSource>
  category: ColumnType<FeedbackCategory, FeedbackCategory, FeedbackCategory>
  severity: ColumnType<FeedbackSeverity, FeedbackSeverity, FeedbackSeverity>
  summary: string
  details: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  recurrence_key: string | null
  status: ColumnType<FeedbackStatus, FeedbackStatus | undefined, FeedbackStatus>
  remediation_status: ColumnType<
    RemediationStatus,
    RemediationStatus | undefined,
    RemediationStatus
  >
  remediation_notes: string | null
  resolved_at: Date | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type FeedbackItem = Selectable<FeedbackItemTable>
export type NewFeedbackItem = Insertable<FeedbackItemTable>
export type FeedbackItemUpdate = Updateable<FeedbackItemTable>

// ---------------------------------------------------------------------------
// Table: feedback_action
// ---------------------------------------------------------------------------
export interface FeedbackActionTable {
  id: Generated<number>
  feedback_id: string
  action_type: ColumnType<FeedbackActionType, FeedbackActionType, FeedbackActionType>
  action_ref: string | null
  description: string | null
  status: ColumnType<FeedbackActionStatus, FeedbackActionStatus | undefined, FeedbackActionStatus>
  created_at: ColumnType<Date, Date | undefined, never>
  verified_at: Date | null
}

export type FeedbackAction = Selectable<FeedbackActionTable>
export type NewFeedbackAction = Insertable<FeedbackActionTable>
export type FeedbackActionUpdate = Updateable<FeedbackActionTable>

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
  credential_class: ColumnType<CredentialClass, CredentialClass | undefined, CredentialClass>
  tool_name: string | null
  metadata: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type ProviderCredential = Selectable<ProviderCredentialTable>
export type NewProviderCredential = Insertable<ProviderCredentialTable>
export type ProviderCredentialUpdate = Updateable<ProviderCredentialTable>

// ---------------------------------------------------------------------------
// Table: agent_channel_binding
// ---------------------------------------------------------------------------
export interface AgentChannelBindingTable {
  id: Generated<string>
  agent_id: string
  channel_type: string
  chat_id: string
  is_default: ColumnType<boolean, boolean | undefined, boolean>
  created_at: ColumnType<Date, Date | undefined, never>
}

export type AgentChannelBinding = Selectable<AgentChannelBindingTable>
export type NewAgentChannelBinding = Insertable<AgentChannelBindingTable>

// ---------------------------------------------------------------------------
// Table: agent_credential_binding
// ---------------------------------------------------------------------------
export interface AgentCredentialBindingTable {
  id: Generated<string>
  agent_id: string
  provider_credential_id: string
  scope: string | null
  created_at: ColumnType<Date, Date | undefined, never>
}

export type AgentCredentialBinding = Selectable<AgentCredentialBindingTable>
export type NewAgentCredentialBinding = Insertable<AgentCredentialBindingTable>

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
// Table: mcp_server
// ---------------------------------------------------------------------------
export interface McpServerTable {
  id: Generated<string>
  name: string
  slug: string
  transport: McpTransport
  connection: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  agent_scope: ColumnType<string[], string[] | undefined, string[]>
  description: string | null
  status: ColumnType<McpServerStatus, McpServerStatus | undefined, McpServerStatus>
  protocol_version: string | null
  server_info: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  capabilities: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  health_probe_interval_ms: ColumnType<number, number | undefined, number>
  last_healthy_at: Date | null
  error_message: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type McpServer = Selectable<McpServerTable>
export type NewMcpServer = Insertable<McpServerTable>
export type McpServerUpdate = Updateable<McpServerTable>

// ---------------------------------------------------------------------------
// Table: mcp_server_tool
// ---------------------------------------------------------------------------
export interface McpServerToolTable {
  id: Generated<string>
  mcp_server_id: string
  name: string
  qualified_name: string
  description: string | null
  input_schema: ColumnType<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >
  annotations: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  status: ColumnType<string, string | undefined, string>
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type McpServerTool = Selectable<McpServerToolTable>
export type NewMcpServerTool = Insertable<McpServerToolTable>
export type McpServerToolUpdate = Updateable<McpServerToolTable>

// ---------------------------------------------------------------------------
// Enum: tool_approval_policy
// ---------------------------------------------------------------------------
export type ToolApprovalPolicy = "auto" | "always_approve" | "conditional"

// ---------------------------------------------------------------------------
// Table: agent_tool_binding
// ---------------------------------------------------------------------------
export interface AgentToolBindingTable {
  id: Generated<string>
  agent_id: string
  tool_ref: string
  approval_policy: ColumnType<
    ToolApprovalPolicy,
    ToolApprovalPolicy | undefined,
    ToolApprovalPolicy
  >
  approval_condition: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  rate_limit: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  cost_budget: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  data_scope: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  enabled: ColumnType<boolean, boolean | undefined, boolean>
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type AgentToolBinding = Selectable<AgentToolBindingTable>
export type NewAgentToolBinding = Insertable<AgentToolBindingTable>
export type AgentToolBindingUpdate = Updateable<AgentToolBindingTable>

// ---------------------------------------------------------------------------
// Table: capability_audit_log
// ---------------------------------------------------------------------------
export interface CapabilityAuditLogTable {
  id: Generated<string>
  agent_id: string
  tool_ref: string
  event_type: string
  actor_user_id: string | null
  details: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  created_at: ColumnType<Date, Date | undefined, never>
}

export type CapabilityAuditLog = Selectable<CapabilityAuditLogTable>
export type NewCapabilityAuditLog = Insertable<CapabilityAuditLogTable>

// ---------------------------------------------------------------------------
// Database interface — register all tables here.
// ---------------------------------------------------------------------------
export interface Database {
  agent: AgentTable
  user_account: UserAccountTable
  channel_mapping: ChannelMappingTable
  session: SessionTable
  session_message: SessionMessageTable
  memory_extract_session_state: MemoryExtractSessionStateTable
  memory_extract_message: MemoryExtractMessageTable
  job: JobTable
  approval_request: ApprovalRequestTable
  approval_audit_log: ApprovalAuditLogTable
  feedback_item: FeedbackItemTable
  feedback_action: FeedbackActionTable
  dashboard_session: DashboardSessionTable
  provider_credential: ProviderCredentialTable
  credential_audit_log: CredentialAuditLogTable
  agent_channel_binding: AgentChannelBindingTable
  agent_credential_binding: AgentCredentialBindingTable
  mcp_server: McpServerTable
  mcp_server_tool: McpServerToolTable
  agent_tool_binding: AgentToolBindingTable
  capability_audit_log: CapabilityAuditLogTable
}
