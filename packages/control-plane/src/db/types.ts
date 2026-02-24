import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely"

import type { AgentStatus, ApprovalStatus, JobStatus } from "@cortex/shared"

// ---------------------------------------------------------------------------
// Table: agent
// ---------------------------------------------------------------------------
export interface AgentTable {
  id: Generated<string>
  name: string
  slug: string
  role: string
  description: string | null
  model_config: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>
  skill_config: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>
  resource_limits: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>
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
  created_at: ColumnType<Date, Date | undefined, never>
}

export type UserAccount = Selectable<UserAccountTable>
export type NewUserAccount = Insertable<UserAccountTable>

// ---------------------------------------------------------------------------
// Table: channel_mapping
// ---------------------------------------------------------------------------
export interface ChannelMappingTable {
  id: Generated<string>
  user_account_id: string
  channel_type: string
  channel_user_id: string
  metadata: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>
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
  metadata: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>
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
}

export type ApprovalRequest = Selectable<ApprovalRequestTable>
export type NewApprovalRequest = Insertable<ApprovalRequestTable>
export type ApprovalRequestUpdate = Updateable<ApprovalRequestTable>

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
}
