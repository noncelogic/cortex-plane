import type { Kysely } from "kysely"

import type { ChannelAllowlistService } from "../channels/channel-allowlist-service.js"
import type { AgentAuthModel, Database } from "../db/types.js"
import type { AccessRequestService } from "./access-request-service.js"
import type { PairingService, RedeemResult } from "./pairing-service.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  agentId: string
  channelType: string
  channelUserId: string
  chatId: string
  messageText?: string
  channelConfigId?: string
  /** Whether the caller intends to read or write. Defaults to "write". */
  intent?: "read" | "write"
}

export type AuthDecisionReason =
  | "granted"
  | "auto_team"
  | "auto_open"
  | "pending_approval"
  | "denied"
  | "channel_denied"
  | "rate_limited"
  | "budget_exceeded"
  | "revoked"
  | "expired"
  | "read_only"

export interface AuthDecision {
  allowed: boolean
  userId: string
  grantId?: string
  reason: AuthDecisionReason
  accessLevel?: "read" | "write"
  replyToUser?: string
}

export interface PairingResult {
  success: boolean
  message: string
  grantId?: string
}

export interface ChannelAuthGuardDeps {
  db: Kysely<Database>
  pairingService: PairingService
  accessRequestService: AccessRequestService
  channelAllowlistService?: ChannelAllowlistService
}

// ---------------------------------------------------------------------------
// Default messages
// ---------------------------------------------------------------------------

const DEFAULT_REJECTION_MESSAGE = "This agent is private. Ask an operator for a pairing code."
const DEFAULT_PENDING_MESSAGE = "Your request has been submitted. You'll be notified when approved."
const DEFAULT_CHANNEL_DENIED_MESSAGE =
  "You are not authorized to use this channel. Contact an operator to be added to the allowlist."

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ChannelAuthGuard {
  private db: Kysely<Database>
  private pairingService: PairingService
  private accessRequestService: AccessRequestService
  private channelAllowlistService?: ChannelAllowlistService

  constructor(deps: ChannelAuthGuardDeps) {
    this.db = deps.db
    this.pairingService = deps.pairingService
    this.accessRequestService = deps.accessRequestService
    this.channelAllowlistService = deps.channelAllowlistService
  }

  /**
   * Main authorization entry point.
   *
   * Resolves the channel identity, looks up the agent's auth model,
   * checks for an existing grant, and applies the appropriate policy.
   */
  async authorize(params: AuthorizeParams): Promise<AuthDecision> {
    const {
      agentId,
      channelType,
      channelUserId,
      chatId,
      messageText,
      channelConfigId,
      intent = "write",
    } = params

    // 1. Resolve or create identity
    const { userAccountId, channelMappingId } = await this.resolveOrCreateIdentity(
      channelType,
      channelUserId,
    )

    // 1b. Channel-level allowlist gate
    if (channelConfigId && this.channelAllowlistService) {
      const policy = await this.channelAllowlistService.getPolicy(channelConfigId)
      if (policy === "allowlist") {
        const allowed = await this.channelAllowlistService.isAllowed(channelConfigId, channelUserId)
        if (!allowed) {
          return {
            allowed: false,
            userId: userAccountId,
            reason: "channel_denied",
            replyToUser: DEFAULT_CHANNEL_DENIED_MESSAGE,
          }
        }
      }
    }

    // 2. Fetch agent to get auth_model + channel_permissions
    const agent = await this.db
      .selectFrom("agent")
      .select(["id", "auth_model", "channel_permissions"])
      .where("id", "=", agentId)
      .executeTakeFirst()

    if (!agent) {
      return {
        allowed: false,
        userId: userAccountId,
        reason: "denied",
        replyToUser: "Agent not found.",
      }
    }

    const authModel: AgentAuthModel = agent.auth_model ?? "allowlist"
    const permissions = agent.channel_permissions ?? {}

    // 3. Look up existing grant (most recent, including revoked/expired)
    const grant = await this.db
      .selectFrom("agent_user_grant")
      .selectAll()
      .where("agent_id", "=", agentId)
      .where("user_account_id", "=", userAccountId)
      .orderBy("created_at", "desc")
      .executeTakeFirst()

    // 4. Check revoked/expired before anything else
    if (grant) {
      if (grant.revoked_at) {
        return {
          allowed: false,
          userId: userAccountId,
          reason: "revoked",
          replyToUser: "Your access to this agent has been revoked.",
        }
      }

      if (grant.expires_at && new Date(grant.expires_at) <= new Date()) {
        return {
          allowed: false,
          userId: userAccountId,
          reason: "expired",
          replyToUser: "Your access to this agent has expired.",
        }
      }

      // Valid grant exists — check access_level vs intent
      const grantLevel = grant.access_level ?? "write"
      if (intent === "write" && grantLevel === "read") {
        return {
          allowed: false,
          userId: userAccountId,
          grantId: grant.id,
          reason: "read_only",
          accessLevel: "read",
          replyToUser: "You have read-only access to this agent.",
        }
      }

      return {
        allowed: true,
        userId: userAccountId,
        grantId: grant.id,
        reason: "granted",
        accessLevel: grantLevel,
      }
    }

    // 5. No grant — apply auth model policy
    switch (authModel) {
      case "allowlist":
        return this.handleAllowlist(userAccountId, permissions)

      case "approval_queue":
        return this.handleApprovalQueue(
          agentId,
          userAccountId,
          channelMappingId,
          permissions,
          messageText,
        )

      case "team":
        return this.handleTeam(agentId, userAccountId, chatId, permissions)

      case "open":
        return this.handleOpen(agentId, userAccountId)

      default:
        return {
          allowed: false,
          userId: userAccountId,
          reason: "denied",
          replyToUser: DEFAULT_REJECTION_MESSAGE,
        }
    }
  }

  /**
   * Redeem a pairing code to create a grant for the channel user.
   */
  async handlePairingCode(
    code: string,
    channelMappingId: string,
    userAccountId: string,
  ): Promise<PairingResult> {
    const result: RedeemResult = await this.pairingService.redeem(
      code,
      channelMappingId,
      userAccountId,
    )

    return {
      success: result.success,
      message: result.message,
      grantId: result.grantId,
    }
  }

  /**
   * Resolve an existing channel identity or create a new user_account +
   * channel_mapping for an unknown channel user.
   */
  async resolveOrCreateIdentity(
    channelType: string,
    channelUserId: string,
    displayName?: string,
  ): Promise<{ userAccountId: string; channelMappingId: string }> {
    // Look up existing channel_mapping
    const existing = await this.db
      .selectFrom("channel_mapping")
      .select(["id", "user_account_id"])
      .where("channel_type", "=", channelType)
      .where("channel_user_id", "=", channelUserId)
      .executeTakeFirst()

    if (existing) {
      return {
        userAccountId: existing.user_account_id,
        channelMappingId: existing.id,
      }
    }

    // Create anonymous user_account
    const userAccount = await this.db
      .insertInto("user_account")
      .values({
        display_name: displayName ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Create channel_mapping
    const channelMapping = await this.db
      .insertInto("channel_mapping")
      .values({
        user_account_id: userAccount.id,
        channel_type: channelType,
        channel_user_id: channelUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return {
      userAccountId: userAccount.id,
      channelMappingId: channelMapping.id,
    }
  }

  // -------------------------------------------------------------------------
  // Private — auth model handlers
  // -------------------------------------------------------------------------

  private handleAllowlist(
    userAccountId: string,
    permissions: Record<string, unknown>,
  ): AuthDecision {
    const message =
      (permissions.rejection_message as string | undefined) ?? DEFAULT_REJECTION_MESSAGE

    return {
      allowed: false,
      userId: userAccountId,
      reason: "denied",
      replyToUser: message,
    }
  }

  private async handleApprovalQueue(
    agentId: string,
    userAccountId: string,
    channelMappingId: string,
    permissions: Record<string, unknown>,
    messageText?: string,
  ): Promise<AuthDecision> {
    const message = (permissions.pending_message as string | undefined) ?? DEFAULT_PENDING_MESSAGE

    // AccessRequestService.create() is idempotent — returns existing pending
    // request if one already exists for (agent_id, user_account_id).
    await this.accessRequestService.create(agentId, userAccountId, channelMappingId, messageText)

    return {
      allowed: false,
      userId: userAccountId,
      reason: "pending_approval",
      replyToUser: message,
    }
  }

  private async handleTeam(
    agentId: string,
    userAccountId: string,
    chatId: string,
    permissions: Record<string, unknown>,
  ): Promise<AuthDecision> {
    // Team membership: check if the agent is bound to the same chat
    const binding = await this.db
      .selectFrom("agent_channel_binding")
      .select("id")
      .where("agent_id", "=", agentId)
      .where("chat_id", "=", chatId)
      .executeTakeFirst()

    if (!binding) {
      const message =
        (permissions.rejection_message as string | undefined) ??
        "You must be a member of a channel this agent is bound to."

      return {
        allowed: false,
        userId: userAccountId,
        reason: "denied",
        replyToUser: message,
      }
    }

    // Auto-create grant with origin 'auto_team' (idempotent on concurrent requests)
    const grant = await this.upsertAutoGrant(agentId, userAccountId, "auto_team")

    return {
      allowed: true,
      userId: userAccountId,
      grantId: grant.id,
      reason: "auto_team",
    }
  }

  private async handleOpen(agentId: string, userAccountId: string): Promise<AuthDecision> {
    // Auto-create grant with origin 'auto_open' (idempotent on concurrent requests)
    const grant = await this.upsertAutoGrant(agentId, userAccountId, "auto_open")

    return {
      allowed: true,
      userId: userAccountId,
      grantId: grant.id,
      reason: "auto_open",
    }
  }

  /**
   * Insert a grant or return the existing one if a concurrent request already
   * created it (UNIQUE constraint on agent_id + user_account_id).
   */
  private async upsertAutoGrant(
    agentId: string,
    userAccountId: string,
    origin: "auto_team" | "auto_open",
  ): Promise<{ id: string }> {
    try {
      return await this.db
        .insertInto("agent_user_grant")
        .values({
          agent_id: agentId,
          user_account_id: userAccountId,
          origin,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "23505") {
        // UNIQUE violation — concurrent request already created the grant
        const existing = await this.db
          .selectFrom("agent_user_grant")
          .select("id")
          .where("agent_id", "=", agentId)
          .where("user_account_id", "=", userAccountId)
          .where("revoked_at", "is", null)
          .executeTakeFirst()
        if (existing) return existing
      }
      throw err
    }
  }
}
