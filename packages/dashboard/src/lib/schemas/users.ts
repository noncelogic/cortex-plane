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
// Access request
// ---------------------------------------------------------------------------

export const AccessRequestSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  user_account_id: z.string(),
  channel_mapping_id: z.string().nullable(),
  status: z.enum(["pending", "approved", "denied"]),
  message_preview: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  deny_reason: z.string().nullable(),
  created_at: z.string(),
})

export type AccessRequest = z.infer<typeof AccessRequestSchema>

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

export const PairingCodeSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable(),
  code: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  redeemed_at: z.string().nullable(),
  redeemed_by: z.string().nullable(),
  revoked_at: z.string().nullable(),
})

export type PairingCode = z.infer<typeof PairingCodeSchema>

// ---------------------------------------------------------------------------
// GET /agents/:agentId/users response
// ---------------------------------------------------------------------------

export const GrantListResponseSchema = z.object({
  grants: z.array(UserGrantSchema),
  total: z.number(),
})

export type GrantListResponse = z.infer<typeof GrantListResponseSchema>

// ---------------------------------------------------------------------------
// POST /agents/:agentId/users response
// ---------------------------------------------------------------------------

export const CreateGrantResponseSchema = z.object({
  grant: UserGrantSchema,
})

export type CreateGrantResponse = z.infer<typeof CreateGrantResponseSchema>

// ---------------------------------------------------------------------------
// GET /agents/:agentId/access-requests response
// ---------------------------------------------------------------------------

export const AccessRequestListResponseSchema = z.object({
  requests: z.array(AccessRequestSchema),
  total: z.number(),
})

export type AccessRequestListResponse = z.infer<typeof AccessRequestListResponseSchema>

// ---------------------------------------------------------------------------
// POST /agents/:agentId/pairing-codes response
// ---------------------------------------------------------------------------

export const GeneratePairingCodeResponseSchema = z.object({
  code: z.string(),
  expiresAt: z.string(),
})

export type GeneratePairingCodeResponse = z.infer<typeof GeneratePairingCodeResponseSchema>

// ---------------------------------------------------------------------------
// GET /agents/:agentId/pairing-codes response
// ---------------------------------------------------------------------------

export const PairingCodeListResponseSchema = z.object({
  codes: z.array(PairingCodeSchema),
})

export type PairingCodeListResponse = z.infer<typeof PairingCodeListResponseSchema>

// ---------------------------------------------------------------------------
// GET /access-requests/pending-count response
// ---------------------------------------------------------------------------

export const PendingCountResponseSchema = z.object({
  counts: z.record(z.string(), z.number()),
})

export type PendingCountResponse = z.infer<typeof PendingCountResponseSchema>

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
