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
// Enum: tool_approval_policy
// ---------------------------------------------------------------------------
export type ToolApprovalPolicy = "auto" | "always_approve" | "conditional"

// ---------------------------------------------------------------------------
// Enum: mcp_server_status
// ---------------------------------------------------------------------------
export type McpServerStatus = "PENDING" | "ACTIVE" | "DEGRADED" | "ERROR" | "DISABLED"

// ---------------------------------------------------------------------------
// Enum: agent_auth_model
// ---------------------------------------------------------------------------
export type AgentAuthModel = "allowlist" | "approval_queue" | "team" | "open"

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
  auth_model: ColumnType<AgentAuthModel, AgentAuthModel | undefined, AgentAuthModel>
  status: ColumnType<AgentStatus, AgentStatus | undefined, AgentStatus>
  health_reset_at: ColumnType<Date | null, Date | null | undefined, Date | null>
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
  total_tokens_in: ColumnType<number, number | undefined, number>
  total_tokens_out: ColumnType<number, number | undefined, number>
  total_cost_usd: ColumnType<string, string | number | undefined, string | number>
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
  tokens_in: ColumnType<number, number | undefined, number>
  tokens_out: ColumnType<number, number | undefined, number>
  cost_usd: ColumnType<string, string | number | undefined, string | number>
  tool_call_count: ColumnType<number, number | undefined, number>
  llm_call_count: ColumnType<number, number | undefined, number>
  parent_job_id: string | null
  delegation_depth: ColumnType<number, number | undefined, number>
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
  job_id: string | null
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
// Table: tool_category
// ---------------------------------------------------------------------------
export interface ToolCategoryTable {
  id: Generated<string>
  name: string
  icon: string | null
  description: string | null
}

export type ToolCategory = Selectable<ToolCategoryTable>
export type NewToolCategory = Insertable<ToolCategoryTable>
export type ToolCategoryUpdate = Updateable<ToolCategoryTable>

// ---------------------------------------------------------------------------
// Table: tool_category_membership
// ---------------------------------------------------------------------------
export interface ToolCategoryMembershipTable {
  tool_ref: string
  category_id: string
}

export type ToolCategoryMembership = Selectable<ToolCategoryMembershipTable>
export type NewToolCategoryMembership = Insertable<ToolCategoryMembershipTable>

// ---------------------------------------------------------------------------
// Table: agent_checkpoint
// ---------------------------------------------------------------------------
export interface AgentCheckpointTable {
  id: Generated<string>
  agent_id: string
  job_id: string | null
  label: string | null
  state: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  state_crc: number
  context_snapshot: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  created_at: ColumnType<Date, Date | undefined, never>
  created_by: ColumnType<string, string | undefined, string>
}

export type AgentCheckpoint = Selectable<AgentCheckpointTable>
export type NewAgentCheckpoint = Insertable<AgentCheckpointTable>

// ---------------------------------------------------------------------------
// Enum: grant_access_level
// ---------------------------------------------------------------------------
export type GrantAccessLevel = "read" | "write"

// ---------------------------------------------------------------------------
// Enum: grant_origin
// ---------------------------------------------------------------------------
export type GrantOrigin =
  | "pairing_code"
  | "dashboard_invite"
  | "auto_team"
  | "auto_open"
  | "approval"

// ---------------------------------------------------------------------------
// Table: pairing_code
// ---------------------------------------------------------------------------
export interface PairingCodeTable {
  id: Generated<string>
  code: string
  agent_id: string | null
  created_by: string
  redeemed_by: string | null
  redeemed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>
  expires_at: Date
  created_at: ColumnType<Date, Date | undefined, never>
}

export type PairingCode = Selectable<PairingCodeTable>
export type NewPairingCode = Insertable<PairingCodeTable>
export type PairingCodeUpdate = Updateable<PairingCodeTable>

// ---------------------------------------------------------------------------
// Table: agent_user_grant
// ---------------------------------------------------------------------------
export interface AgentUserGrantTable {
  id: Generated<string>
  agent_id: string
  user_account_id: string
  access_level: ColumnType<GrantAccessLevel, GrantAccessLevel | undefined, GrantAccessLevel>
  origin: GrantOrigin
  granted_by: string | null
  rate_limit: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  token_budget: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >
  expires_at: Date | null
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>
  created_at: ColumnType<Date, Date | undefined, never>
}

export type AgentUserGrant = Selectable<AgentUserGrantTable>
export type NewAgentUserGrant = Insertable<AgentUserGrantTable>
export type AgentUserGrantUpdate = Updateable<AgentUserGrantTable>

// ---------------------------------------------------------------------------
// Table: user_usage_ledger
// ---------------------------------------------------------------------------
export interface UserUsageLedgerTable {
  id: Generated<string>
  user_account_id: string
  agent_id: string
  period_start: Date
  period_end: Date
  messages_sent: ColumnType<number, number | undefined, number>
  tokens_in: ColumnType<number, number | undefined, number>
  tokens_out: ColumnType<number, number | undefined, number>
  cost_usd: ColumnType<string, string | number | undefined, string | number>
  created_at: ColumnType<Date, Date | undefined, never>
}

export type UserUsageLedger = Selectable<UserUsageLedgerTable>
export type NewUserUsageLedger = Insertable<UserUsageLedgerTable>
export type UserUsageLedgerUpdate = Updateable<UserUsageLedgerTable>

// ---------------------------------------------------------------------------
// Rate limit / token budget shapes (stored as JSONB in agent_user_grant)
// ---------------------------------------------------------------------------
export interface RateLimit {
  max_messages: number
  window_seconds: number
}

export interface TokenBudget {
  max_tokens: number
  window_seconds: number
}

// ---------------------------------------------------------------------------
// Enum: access_request_status
// ---------------------------------------------------------------------------
export type AccessRequestStatus = "pending" | "approved" | "denied"

// ---------------------------------------------------------------------------
// Table: access_request
// ---------------------------------------------------------------------------
export interface AccessRequestTable {
  id: Generated<string>
  agent_id: string
  channel_mapping_id: string
  user_account_id: string
  status: ColumnType<AccessRequestStatus, AccessRequestStatus | undefined, AccessRequestStatus>
  message_preview: string | null
  reviewed_by: string | null
  reviewed_at: ColumnType<Date | null, Date | null | undefined, Date | null>
  deny_reason: string | null
  created_at: ColumnType<Date, Date | undefined, never>
}

export type AccessRequest = Selectable<AccessRequestTable>
export type NewAccessRequest = Insertable<AccessRequestTable>
export type AccessRequestUpdate = Updateable<AccessRequestTable>

// ---------------------------------------------------------------------------
// Enum: agent_event_type
// ---------------------------------------------------------------------------
export type AgentEventType =
  | "llm_call_start"
  | "llm_call_end"
  | "tool_call_start"
  | "tool_call_end"
  | "tool_denied"
  | "tool_rate_limited"
  | "message_received"
  | "message_sent"
  | "state_transition"
  | "circuit_breaker_trip"
  | "cost_alert"
  | "steer_injected"
  | "steer_acknowledged"
  | "kill_requested"
  | "checkpoint_created"
  | "error"
  | "message_denied"
  | "session_start"
  | "session_end"

// ---------------------------------------------------------------------------
// Table: agent_event
// ---------------------------------------------------------------------------
export interface AgentEventTable {
  id: Generated<string>
  agent_id: string
  session_id: string | null
  job_id: string | null
  parent_event_id: string | null
  event_type: string
  payload: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: ColumnType<string | null, string | number | null | undefined, string | number | null>
  duration_ms: number | null
  model: string | null
  tool_ref: string | null
  actor: string | null
  created_at: ColumnType<Date, Date | undefined, never>
}

export type AgentEvent = Selectable<AgentEventTable>
export type NewAgentEvent = Insertable<AgentEventTable>

// ---------------------------------------------------------------------------
// Table: channel_config
// ---------------------------------------------------------------------------
export type ChannelType = "telegram" | "discord" | "whatsapp"

// ---------------------------------------------------------------------------
// Enum: channel_inbound_policy
// ---------------------------------------------------------------------------
export type ChannelInboundPolicy = "open" | "allowlist"

export interface BotMetadata {
  bot_id: string
  username: string
  display_name: string
}

export interface ChannelConfigTable {
  id: Generated<string>
  type: ChannelType
  name: string
  config_enc: string
  bot_metadata: ColumnType<BotMetadata | null, string | null | undefined, string | null>
  enabled: ColumnType<boolean, boolean | undefined, boolean>
  inbound_policy: ColumnType<
    ChannelInboundPolicy,
    ChannelInboundPolicy | undefined,
    ChannelInboundPolicy
  >
  created_by: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type ChannelConfig = Selectable<ChannelConfigTable>
export type NewChannelConfig = Insertable<ChannelConfigTable>
export type ChannelConfigUpdate = Updateable<ChannelConfigTable>

// ---------------------------------------------------------------------------
// Table: channel_allowlist
// ---------------------------------------------------------------------------
export interface ChannelAllowlistTable {
  id: Generated<string>
  channel_config_id: string
  platform_user_id: string
  display_name: string | null
  note: string | null
  added_by: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type ChannelAllowlistEntry = Selectable<ChannelAllowlistTable>
export type NewChannelAllowlistEntry = Insertable<ChannelAllowlistTable>
export type ChannelAllowlistEntryUpdate = Updateable<ChannelAllowlistTable>

// ---------------------------------------------------------------------------
// Table: channel_allowlist_audit
// ---------------------------------------------------------------------------
export interface ChannelAllowlistAuditTable {
  id: Generated<string>
  channel_config_id: string
  action: string
  platform_user_id: string | null
  performed_by: string | null
  detail: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  created_at: ColumnType<Date, Date | undefined, never>
}

export type ChannelAllowlistAudit = Selectable<ChannelAllowlistAuditTable>
export type NewChannelAllowlistAudit = Insertable<ChannelAllowlistAuditTable>

// ---------------------------------------------------------------------------
// Enum: content_status
// ---------------------------------------------------------------------------
export type ContentStatus = "DRAFT" | "IN_REVIEW" | "QUEUED" | "PUBLISHED" | "ARCHIVED"

// ---------------------------------------------------------------------------
// Enum: content_type
// ---------------------------------------------------------------------------
export type ContentItemType = "blog" | "social" | "newsletter" | "report"

// ---------------------------------------------------------------------------
// Table: content_item
// ---------------------------------------------------------------------------
export interface ContentItemTable {
  id: Generated<string>
  agent_id: string
  title: string
  body: ColumnType<string, string | undefined, string>
  type: ColumnType<ContentItemType, ContentItemType | undefined, ContentItemType>
  status: ColumnType<ContentStatus, ContentStatus | undefined, ContentStatus>
  channel: string | null
  metadata: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >
  published_at: Date | null
  archived_at: Date | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export type ContentItem = Selectable<ContentItemTable>
export type NewContentItem = Insertable<ContentItemTable>
export type ContentItemUpdate = Updateable<ContentItemTable>

// ---------------------------------------------------------------------------
// Table: browser_screenshot
// ---------------------------------------------------------------------------
export type BrowserScreenshotEventType =
  | "GET"
  | "CLICK"
  | "CONSOLE"
  | "SNAPSHOT"
  | "NAVIGATE"
  | "ERROR"
export type BrowserEventSeverity = "info" | "warn" | "error"

export interface BrowserScreenshotTable {
  id: Generated<string>
  agent_id: string
  thumbnail_url: string
  full_url: string
  width: number
  height: number
  created_at: ColumnType<Date, Date | undefined, never>
}

export type BrowserScreenshot = Selectable<BrowserScreenshotTable>
export type NewBrowserScreenshot = Insertable<BrowserScreenshotTable>

// ---------------------------------------------------------------------------
// Table: browser_event
// ---------------------------------------------------------------------------
export interface BrowserEventTable {
  id: Generated<string>
  agent_id: string
  type: ColumnType<
    BrowserScreenshotEventType,
    BrowserScreenshotEventType,
    BrowserScreenshotEventType
  >
  url: string | null
  selector: string | null
  message: string | null
  duration_ms: number | null
  severity: ColumnType<BrowserEventSeverity, BrowserEventSeverity | undefined, BrowserEventSeverity>
  created_at: ColumnType<Date, Date | undefined, never>
}

export type BrowserEvent = Selectable<BrowserEventTable>
export type NewBrowserEvent = Insertable<BrowserEventTable>

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
  tool_category: ToolCategoryTable
  tool_category_membership: ToolCategoryMembershipTable
  agent_checkpoint: AgentCheckpointTable
  agent_event: AgentEventTable
  pairing_code: PairingCodeTable
  agent_user_grant: AgentUserGrantTable
  access_request: AccessRequestTable
  user_usage_ledger: UserUsageLedgerTable
  channel_config: ChannelConfigTable
  channel_allowlist: ChannelAllowlistTable
  channel_allowlist_audit: ChannelAllowlistAuditTable
  content_item: ContentItemTable
  browser_screenshot: BrowserScreenshotTable
  browser_event: BrowserEventTable
}
