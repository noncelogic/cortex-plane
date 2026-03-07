import { z } from "zod"

// ---------------------------------------------------------------------------
// User account
// ---------------------------------------------------------------------------

export const UserAccountSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: z.enum(["operator", "approver", "admin"]),
  oauth_provider: z.string().nullable(),
  oauth_provider_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type UserAccount = z.infer<typeof UserAccountSchema>

// ---------------------------------------------------------------------------
// Channel mapping
// ---------------------------------------------------------------------------

export const ChannelMappingSchema = z.object({
  id: z.string(),
  user_account_id: z.string(),
  channel_type: z.string(),
  channel_user_id: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
})

export type ChannelMapping = z.infer<typeof ChannelMappingSchema>

// ---------------------------------------------------------------------------
// User grant (from agent_user_grant)
// ---------------------------------------------------------------------------

export const UserGrantSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  user_account_id: z.string(),
  access_level: z.enum(["read", "write"]),
  origin: z.enum(["pairing_code", "dashboard_invite", "auto_team", "auto_open", "approval"]),
  granted_by: z.string().nullable(),
  rate_limit: z.record(z.string(), z.unknown()).nullable(),
  token_budget: z.record(z.string(), z.unknown()).nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
})

export type UserGrant = z.infer<typeof UserGrantSchema>

// ---------------------------------------------------------------------------
// User usage ledger
// ---------------------------------------------------------------------------

export const UserUsageLedgerSchema = z.object({
  id: z.string(),
  user_account_id: z.string(),
  agent_id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  messages_sent: z.number(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.string(),
  created_at: z.string(),
})

export type UserUsageLedger = z.infer<typeof UserUsageLedgerSchema>

// ---------------------------------------------------------------------------
// GET /users/:id response
// ---------------------------------------------------------------------------

export const UserDetailResponseSchema = z.object({
  user: UserAccountSchema,
  channelMappings: z.array(ChannelMappingSchema),
  grants: z.array(UserGrantSchema),
})

export type UserDetailResponse = z.infer<typeof UserDetailResponseSchema>

// ---------------------------------------------------------------------------
// GET /users/:id/usage response
// ---------------------------------------------------------------------------

export const UserUsageResponseSchema = z.object({
  usage: z.array(UserUsageLedgerSchema),
})

export type UserUsageResponse = z.infer<typeof UserUsageResponseSchema>
