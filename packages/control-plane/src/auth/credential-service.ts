/**
 * Provider Credential Service
 *
 * Manages encrypted LLM provider credentials (OAuth tokens + API keys).
 * All sensitive values are encrypted with the user's per-user key
 * before storage and decrypted only when needed for API calls.
 *
 * Supports:
 *   - OAuth credentials (Google Antigravity, OpenAI Codex)
 *   - API key credentials (Anthropic, OpenAI direct, Google AI Studio)
 *   - Server-side token refresh for OAuth providers
 *   - Credential status tracking + audit logging
 */

import { type Kysely, sql } from "kysely"

import type { AuthOAuthConfig, OAuthProviderConfig } from "../config.js"
import type {
  CredentialClass,
  CredentialStatus,
  Database,
  NewCredentialAuditLog,
  NewProviderCredential,
  ProviderCredential,
} from "../db/types.js"
import {
  decryptCredential,
  decryptUserKey,
  deriveMasterKey,
  encryptCredential,
  encryptUserKey,
  generateUserKey,
  maskApiKey,
} from "./credential-encryption.js"
import { CODE_PASTE_PROVIDERS } from "./oauth-providers.js"
import { refreshAccessToken, type TokenResponse } from "./oauth-service.js"

/** Execution context passed by callers for audit enrichment. */
export interface AuditContext {
  agentId?: string
  jobId?: string
  toolName?: string
}

/** Provider metadata for the "Connected Providers" UI. */
export interface ProviderInfo {
  id: string
  name: string
  authType: "oauth" | "api_key"
  description: string
  credentialClass?: CredentialClass
}

export const SUPPORTED_PROVIDERS: ProviderInfo[] = [
  {
    id: "google-antigravity",
    name: "Google Antigravity",
    authType: "oauth",
    description: "Claude/Gemini via Google Cloud Antigravity",
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    authType: "oauth",
    description: "GPT models via ChatGPT subscription",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    authType: "oauth",
    description: "Claude models via OAuth",
  },
  {
    id: "openai",
    name: "OpenAI",
    authType: "api_key",
    description: "GPT models via direct API key",
  },
  {
    id: "google-ai-studio",
    name: "Google AI Studio",
    authType: "api_key",
    description: "Gemini models via API key",
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    authType: "oauth",
    description: "Google Calendar, Gmail, Drive (acting as the user)",
    credentialClass: "user_service",
  },
  {
    id: "github-user",
    name: "GitHub (user)",
    authType: "oauth",
    description: "GitHub repos, issues, PRs (acting as the user)",
    credentialClass: "user_service",
  },
  {
    id: "slack-user",
    name: "Slack (user)",
    authType: "oauth",
    description: "Slack channels, messages (acting as the user)",
    credentialClass: "user_service",
  },
  {
    id: "brave",
    name: "Brave Search",
    authType: "api_key",
    description: "Brave Search API for web search tools",
    credentialClass: "tool_specific",
  },
]

/** Credential summary returned to the dashboard (no secrets). */
export interface CredentialSummary {
  id: string
  provider: string
  credentialType: "oauth" | "api_key"
  credentialClass: CredentialClass
  toolName: string | null
  displayLabel: string | null
  status: CredentialStatus
  accountId: string | null
  scopes: string[] | null
  tokenExpiresAt: string | null
  lastUsedAt: string | null
  lastRefreshAt: string | null
  maskedKey: string | null
  errorCount: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

function toSummary(cred: ProviderCredential, maskedKey: string | null): CredentialSummary {
  return {
    id: cred.id,
    provider: cred.provider,
    credentialType: cred.credential_type as "oauth" | "api_key",
    credentialClass: cred.credential_class,
    toolName: cred.tool_name ?? null,
    displayLabel: cred.display_label,
    status: cred.status,
    accountId: cred.account_id,
    scopes: cred.scopes,
    tokenExpiresAt: cred.token_expires_at?.toISOString() ?? null,
    lastUsedAt: cred.last_used_at?.toISOString() ?? null,
    lastRefreshAt: cred.last_refresh_at?.toISOString() ?? null,
    maskedKey,
    errorCount: cred.error_count,
    lastError: cred.last_error,
    createdAt: cred.created_at.toISOString(),
    updatedAt: cred.updated_at.toISOString(),
  }
}

export class CredentialService {
  private readonly masterKey: Buffer

  constructor(
    private readonly db: Kysely<Database>,
    private readonly authConfig: AuthOAuthConfig,
  ) {
    this.masterKey = deriveMasterKey(authConfig.credentialMasterKey)
  }

  /**
   * Ensure a user has an encryption key. Creates one if missing.
   */
  private async ensureUserKey(userId: string): Promise<Buffer> {
    const user = await this.db
      .selectFrom("user_account")
      .select("encryption_key_enc")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow()

    if (user.encryption_key_enc) {
      return decryptUserKey(user.encryption_key_enc, this.masterKey)
    }

    // Generate and store a new per-user key
    const userKey = generateUserKey()
    const encryptedKey = encryptUserKey(userKey, this.masterKey)

    await this.db
      .updateTable("user_account")
      .set({ encryption_key_enc: encryptedKey, updated_at: new Date() })
      .where("id", "=", userId)
      .execute()

    return userKey
  }

  /**
   * Store OAuth tokens for a provider.
   */
  async storeOAuthCredential(
    userId: string,
    provider: string,
    tokens: TokenResponse,
    opts?: {
      accountId?: string
      displayLabel?: string
      scopes?: string[]
      credentialClass?: CredentialClass
    },
  ): Promise<CredentialSummary> {
    const userKey = await this.ensureUserKey(userId)

    const values: NewProviderCredential = {
      user_account_id: userId,
      provider,
      credential_type: "oauth",
      credential_class: opts?.credentialClass ?? "llm_provider",
      access_token_enc: encryptCredential(tokens.access_token, userKey),
      refresh_token_enc: tokens.refresh_token
        ? encryptCredential(tokens.refresh_token, userKey)
        : null,
      token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      scopes: opts?.scopes ?? (tokens.scope ? tokens.scope.split(" ") : null),
      account_id: opts?.accountId ?? null,
      display_label: opts?.displayLabel ?? provider,
      status: "active",
    }

    // Upsert: update if provider+label already exists for this user
    const existing = await this.db
      .selectFrom("provider_credential")
      .select("id")
      .where("user_account_id", "=", userId)
      .where("provider", "=", provider)
      .where("display_label", "=", values.display_label!)
      .executeTakeFirst()

    let cred: ProviderCredential
    if (existing) {
      cred = await this.db
        .updateTable("provider_credential")
        .set({
          access_token_enc: values.access_token_enc,
          refresh_token_enc: values.refresh_token_enc,
          token_expires_at: values.token_expires_at,
          scopes: values.scopes,
          account_id: values.account_id,
          status: "active",
          error_count: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(userId, cred.id, "credential_updated", provider, { flow: "oauth" })
    } else {
      cred = await this.db
        .insertInto("provider_credential")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(userId, cred.id, "oauth_connected", provider, { flow: "oauth" })
    }

    return toSummary(cred, null)
  }

  /**
   * Store an API key credential for a provider.
   */
  async storeApiKeyCredential(
    userId: string,
    provider: string,
    apiKey: string,
    opts?: { displayLabel?: string; credentialClass?: CredentialClass },
  ): Promise<CredentialSummary> {
    const userKey = await this.ensureUserKey(userId)

    const values: NewProviderCredential = {
      user_account_id: userId,
      provider,
      credential_type: "api_key",
      credential_class: opts?.credentialClass ?? "llm_provider",
      api_key_enc: encryptCredential(apiKey, userKey),
      display_label: opts?.displayLabel ?? provider,
      status: "active",
    }

    // Upsert
    const existing = await this.db
      .selectFrom("provider_credential")
      .select("id")
      .where("user_account_id", "=", userId)
      .where("provider", "=", provider)
      .where("display_label", "=", values.display_label!)
      .executeTakeFirst()

    let cred: ProviderCredential
    if (existing) {
      cred = await this.db
        .updateTable("provider_credential")
        .set({
          api_key_enc: values.api_key_enc,
          status: "active",
          error_count: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(userId, cred.id, "api_key_rotated", provider)
    } else {
      cred = await this.db
        .insertInto("provider_credential")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(userId, cred.id, "credential_created", provider)
    }

    return toSummary(cred, maskApiKey(apiKey))
  }

  /**
   * List all credentials for a user (no secrets).
   * Optionally filter by credential class.
   */
  async listCredentials(
    userId: string,
    opts?: { credentialClass?: CredentialClass },
  ): Promise<CredentialSummary[]> {
    let query = this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("user_account_id", "=", userId)

    if (opts?.credentialClass) {
      query = query.where("credential_class", "=", opts.credentialClass)
    }

    const creds = await query.orderBy("provider", "asc").orderBy("created_at", "asc").execute()

    const userKey = creds.length > 0 ? await this.ensureUserKey(userId) : null

    return creds.map((cred) => {
      let maskedKey: string | null = null
      if (cred.api_key_enc && userKey) {
        try {
          const plain = decryptCredential(cred.api_key_enc, userKey)
          maskedKey = maskApiKey(plain)
        } catch {
          maskedKey = "****"
        }
      }
      return toSummary(cred, maskedKey)
    })
  }

  /**
   * Store a tool secret credential (API key for an MCP tool).
   * Only admins may call this method.
   */
  async storeToolSecret(
    adminUserId: string,
    toolName: string,
    provider: string,
    apiKey: string,
    opts?: { displayLabel?: string; metadata?: Record<string, unknown> },
  ): Promise<CredentialSummary> {
    // Validate admin role
    const user = await this.db
      .selectFrom("user_account")
      .select("role")
      .where("id", "=", adminUserId)
      .executeTakeFirstOrThrow()

    if (user.role !== "admin") {
      throw new Error("Only admins can store tool secrets")
    }

    const userKey = await this.ensureUserKey(adminUserId)

    const values: NewProviderCredential = {
      user_account_id: adminUserId,
      provider,
      credential_type: "api_key",
      credential_class: "tool_specific",
      tool_name: toolName,
      api_key_enc: encryptCredential(apiKey, userKey),
      display_label: opts?.displayLabel ?? `${toolName}/${provider}`,
      metadata: opts?.metadata ?? {},
      status: "active",
    }

    // Upsert on tool_name + provider
    const existing = await this.db
      .selectFrom("provider_credential")
      .select("id")
      .where("tool_name", "=", toolName)
      .where("provider", "=", provider)
      .where("credential_class", "=", "tool_specific")
      .executeTakeFirst()

    let cred: ProviderCredential
    if (existing) {
      cred = await this.db
        .updateTable("provider_credential")
        .set({
          api_key_enc: values.api_key_enc,
          display_label: values.display_label,
          metadata: values.metadata,
          status: "active",
          error_count: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(adminUserId, cred.id, "credential_updated", provider, {
        flow: "tool_secret",
        tool_name: toolName,
      })
    } else {
      cred = await this.db
        .insertInto("provider_credential")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow()

      await this.auditLog(adminUserId, cred.id, "credential_created", provider, {
        flow: "tool_secret",
        tool_name: toolName,
      })
    }

    return toSummary(cred, maskApiKey(apiKey))
  }

  /**
   * Retrieve a decrypted tool secret by tool name.
   * Decrypts using the owner's user key and audit-logs each access.
   */
  async getToolSecret(
    toolName: string,
    context?: AuditContext,
  ): Promise<{ token: string; credentialId: string; provider: string } | null> {
    const cred = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("credential_class", "=", "tool_specific")
      .where("tool_name", "=", toolName)
      .where("status", "=", "active")
      .executeTakeFirst()

    if (!cred || !cred.api_key_enc) return null

    // Decrypt using the owner's user key
    const userKey = await this.ensureUserKey(cred.user_account_id)
    const token = decryptCredential(cred.api_key_enc, userKey)

    // Audit log each access with execution context
    await this.auditLog(cred.user_account_id, cred.id, "credential_accessed", cred.provider, {
      flow: "injection",
      tool_name: toolName,
      ...(context?.agentId && { agent_id: context.agentId }),
      ...(context?.jobId && { job_id: context.jobId }),
      ...(context?.toolName && { tool_name: context.toolName }),
    })

    await this.markUsed(cred.id)

    return { token, credentialId: cred.id, provider: cred.provider }
  }

  /**
   * Rotate a tool secret's API key by credential ID.
   * Only admins may call this method.
   */
  async rotateToolSecret(
    adminUserId: string,
    credentialId: string,
    newApiKey: string,
  ): Promise<CredentialSummary | null> {
    // Validate admin role
    const user = await this.db
      .selectFrom("user_account")
      .select("role")
      .where("id", "=", adminUserId)
      .executeTakeFirstOrThrow()

    if (user.role !== "admin") {
      throw new Error("Only admins can rotate tool secrets")
    }

    // Find the credential and verify it's a tool secret
    const cred = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("id", "=", credentialId)
      .where("credential_class", "=", "tool_specific")
      .executeTakeFirst()

    if (!cred) {
      return null
    }

    const userKey = await this.ensureUserKey(cred.user_account_id)

    const updated = await this.db
      .updateTable("provider_credential")
      .set({
        api_key_enc: encryptCredential(newApiKey, userKey),
        status: "active",
        error_count: 0,
        last_error: null,
        updated_at: new Date(),
      })
      .where("id", "=", credentialId)
      .returningAll()
      .executeTakeFirstOrThrow()

    await this.auditLog(adminUserId, credentialId, "api_key_rotated", cred.provider, {
      flow: "tool_secret",
      tool_name: cred.tool_name,
    })

    return toSummary(updated, maskApiKey(newApiKey))
  }

  /**
   * List all tool secrets (admin only, no decrypted keys).
   */
  async listToolSecrets(adminUserId: string): Promise<CredentialSummary[]> {
    // Validate admin role
    const user = await this.db
      .selectFrom("user_account")
      .select("role")
      .where("id", "=", adminUserId)
      .executeTakeFirstOrThrow()

    if (user.role !== "admin") {
      throw new Error("Only admins can list tool secrets")
    }

    const creds = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("credential_class", "=", "tool_specific")
      .orderBy("provider", "asc")
      .orderBy("created_at", "asc")
      .execute()

    // Decrypt masked keys per owner
    const keyCache = new Map<string, Buffer>()
    const results: CredentialSummary[] = []

    for (const cred of creds) {
      let maskedKey: string | null = null
      if (cred.api_key_enc) {
        try {
          let userKey = keyCache.get(cred.user_account_id)
          if (!userKey) {
            userKey = await this.ensureUserKey(cred.user_account_id)
            keyCache.set(cred.user_account_id, userKey)
          }
          const plain = decryptCredential(cred.api_key_enc, userKey)
          maskedKey = maskApiKey(plain)
        } catch {
          maskedKey = "****"
        }
      }
      results.push(toSummary(cred, maskedKey))
    }

    return results
  }

  /**
   * Delete a credential.
   */
  async deleteCredential(userId: string, credentialId: string): Promise<void> {
    const cred = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("id", "=", credentialId)
      .where("user_account_id", "=", userId)
      .executeTakeFirst()

    if (!cred) return

    const eventType = cred.credential_type === "oauth" ? "oauth_disconnected" : "credential_deleted"
    await this.auditLog(userId, credentialId, eventType, cred.provider)

    await this.db.deleteFrom("provider_credential").where("id", "=", credentialId).execute()
  }

  /**
   * Get a decrypted access token for a provider (for backend use).
   * Handles automatic token refresh if expired or when forceRefresh is set.
   *
   * @param opts.forceRefresh - When true, always attempt token refresh for
   *   OAuth credentials (used for 401 retry after the LLM provider rejects
   *   a token that was valid at resolution time).
   */
  async getAccessToken(
    userId: string,
    provider: string,
    context?: AuditContext,
    opts?: { forceRefresh?: boolean },
  ): Promise<{ token: string; credentialId: string } | null> {
    const cred = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("user_account_id", "=", userId)
      .where("provider", "=", provider)
      .where("status", "=", "active")
      .orderBy("last_used_at", "desc")
      .executeTakeFirst()

    if (!cred) return null

    const userKey = await this.ensureUserKey(userId)

    // For API keys, just decrypt and return
    if (cred.credential_type === "api_key" && cred.api_key_enc) {
      const token = decryptCredential(cred.api_key_enc, userKey)
      await this.auditAccess(cred, context)
      await this.markUsed(cred.id)
      return { token, credentialId: cred.id }
    }

    // For OAuth, check expiry and refresh if needed
    if (cred.credential_type === "oauth" && cred.access_token_enc) {
      const shouldRefresh =
        opts?.forceRefresh ||
        (cred.token_expires_at &&
          new Date(cred.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) // 5min buffer

      if (shouldRefresh && cred.refresh_token_enc) {
        const refreshed = await this.refreshToken(cred, userKey)
        if (refreshed) {
          await this.auditAccess(cred, context)
          return { token: refreshed, credentialId: cred.id }
        }
        // Refresh failed — fall through to return current token
      }

      const token = decryptCredential(cred.access_token_enc, userKey)
      await this.auditAccess(cred, context)
      await this.markUsed(cred.id)
      return { token, credentialId: cred.id }
    }

    return null
  }

  /**
   * Refresh an OAuth token and update the stored credential.
   */
  private async refreshToken(cred: ProviderCredential, userKey: Buffer): Promise<string | null> {
    if (!cred.refresh_token_enc) return null

    const providerConfig = this.getProviderConfig(cred.provider)
    if (!providerConfig) return null

    const refreshToken = decryptCredential(cred.refresh_token_enc, userKey)

    try {
      const tokens = await refreshAccessToken({
        provider: cred.provider,
        config: providerConfig,
        refreshToken,
      })

      const newAccessEnc = encryptCredential(tokens.access_token, userKey)
      const newRefreshEnc = tokens.refresh_token
        ? encryptCredential(tokens.refresh_token, userKey)
        : cred.refresh_token_enc

      await this.db
        .updateTable("provider_credential")
        .set({
          access_token_enc: newAccessEnc,
          refresh_token_enc: newRefreshEnc,
          token_expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000)
            : cred.token_expires_at,
          last_refresh_at: new Date(),
          last_used_at: new Date(),
          status: "active",
          error_count: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where("id", "=", cred.id)
        .execute()

      await this.auditLog(cred.user_account_id, cred.id, "token_refreshed", cred.provider)

      return tokens.access_token
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown refresh error"
      await this.db
        .updateTable("provider_credential")
        .set({
          error_count: cred.error_count + 1,
          last_error: errorMsg,
          status: "error",
          updated_at: new Date(),
        })
        .where("id", "=", cred.id)
        .execute()

      await this.auditLog(cred.user_account_id, cred.id, "token_expired", cred.provider, {
        error: errorMsg,
      })
      return null
    }
  }

  private getProviderConfig(provider: string): OAuthProviderConfig | undefined {
    switch (provider) {
      case "google-antigravity":
        return this.authConfig.googleAntigravity
      case "openai-codex":
        return this.authConfig.openaiCodex
      case "anthropic": {
        // Anthropic config comes from hardcoded registry (or env override)
        if (this.authConfig.anthropic) return this.authConfig.anthropic
        const reg = CODE_PASTE_PROVIDERS["anthropic"]
        if (reg) {
          return {
            clientId: reg.clientId,
            clientSecret: reg.clientSecret,
            authUrl: reg.authUrl,
            tokenUrl: reg.tokenUrl,
          }
        }
        return undefined
      }
      // User service providers
      case "google-workspace":
        return this.authConfig.googleWorkspace
      case "github-user":
        return this.authConfig.githubUser
      case "slack-user":
        return this.authConfig.slackUser
      default:
        return undefined
    }
  }

  private async markUsed(credentialId: string): Promise<void> {
    await this.db
      .updateTable("provider_credential")
      .set({ last_used_at: new Date() })
      .where("id", "=", credentialId)
      .execute()
  }

  /**
   * Get audit log entries for a user's credentials.
   * Supports optional filters for compliance queries.
   */
  async getAuditLog(
    userId: string,
    opts: {
      limit?: number
      credentialId?: string
      agentId?: string
      eventType?: string
    } = {},
  ): Promise<import("../db/types.js").CredentialAuditLog[]> {
    const limit = opts.limit ?? 50

    let query = this.db
      .selectFrom("credential_audit_log")
      .selectAll()
      .where("user_account_id", "=", userId)

    if (opts.credentialId) {
      query = query.where("provider_credential_id", "=", opts.credentialId)
    }

    if (opts.eventType) {
      query = query.where("event_type", "=", opts.eventType)
    }

    if (opts.agentId) {
      query = query.where(sql`details->>'agent_id'`, "=", opts.agentId)
    }

    return query.orderBy("created_at", "desc").limit(limit).execute()
  }

  /**
   * Proactively refresh OAuth tokens expiring within 30 minutes.
   *
   * Unlike the just-in-time refresh in `getAccessToken`, this method:
   *   - Queries all active OAuth credentials with a refresh token
   *   - Only marks status = 'error' after 3 consecutive failures
   *   - Uses 'refresh_failed' audit event (vs 'token_expired' for JIT)
   *
   * Safe to call concurrently (Graphile Worker job-key deduplication).
   */
  async refreshExpiring(): Promise<{ refreshed: number; failed: number }> {
    const threshold = new Date(Date.now() + 30 * 60 * 1000)

    const creds = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("credential_type", "=", "oauth")
      .where("status", "=", "active")
      .where("refresh_token_enc", "is not", null)
      .where("token_expires_at", "<", threshold)
      .execute()

    let refreshed = 0
    let failed = 0

    for (const cred of creds) {
      const providerConfig = this.getProviderConfig(cred.provider)
      if (!providerConfig || !cred.refresh_token_enc) continue

      try {
        const userKey = await this.ensureUserKey(cred.user_account_id)
        const refreshToken = decryptCredential(cred.refresh_token_enc, userKey)

        const tokens = await refreshAccessToken({
          provider: cred.provider,
          config: providerConfig,
          refreshToken,
        })

        const newAccessEnc = encryptCredential(tokens.access_token, userKey)
        const newRefreshEnc = tokens.refresh_token
          ? encryptCredential(tokens.refresh_token, userKey)
          : cred.refresh_token_enc

        await this.db
          .updateTable("provider_credential")
          .set({
            access_token_enc: newAccessEnc,
            refresh_token_enc: newRefreshEnc,
            token_expires_at: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : cred.token_expires_at,
            last_refresh_at: new Date(),
            status: "active" as const,
            error_count: 0,
            last_error: null,
            updated_at: new Date(),
          })
          .where("id", "=", cred.id)
          .where("status", "=", "active")
          .execute()

        await this.auditLog(cred.user_account_id, cred.id, "token_refreshed", cred.provider)
        refreshed++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown refresh error"
        const newErrorCount = cred.error_count + 1

        await this.db
          .updateTable("provider_credential")
          .set({
            error_count: newErrorCount,
            last_error: errorMsg,
            status: (newErrorCount >= 3 ? "error" : "active") as CredentialStatus,
            updated_at: new Date(),
          })
          .where("id", "=", cred.id)
          .where("status", "=", "active")
          .execute()

        await this.auditLog(cred.user_account_id, cred.id, "refresh_failed", cred.provider, {
          error: errorMsg,
          error_count: newErrorCount,
        })
        failed++
      }
    }

    return { refreshed, failed }
  }

  /**
   * Emit audit events for tool secrets not rotated in 90+ days.
   * Informational only — no automated rotation.
   */
  async emitRotationReminders(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

    const staleSecrets = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("credential_class", "=", "tool_specific")
      .where("status", "=", "active")
      .where("updated_at", "<", staleThreshold)
      .execute()

    for (const cred of staleSecrets) {
      const daysSinceUpdate = Math.floor(
        (Date.now() - cred.updated_at.getTime()) / (24 * 60 * 60 * 1000),
      )

      await this.auditLog(cred.user_account_id, cred.id, "rotation_due", cred.provider, {
        tool_name: cred.tool_name,
        days_since_update: daysSinceUpdate,
      })
    }

    return staleSecrets.length
  }

  /**
   * Test a credential by making a lightweight API call to the provider.
   * Returns a health status indicating whether the credential is functional.
   */
  async testCredential(
    userId: string,
    credentialId: string,
  ): Promise<{
    status: "connected" | "token_expired" | "auth_failed" | "rate_limited" | "error"
    message: string
    tokenExpiresAt?: string | null
    lastUsedAt?: string | null
  }> {
    const cred = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("id", "=", credentialId)
      .where("user_account_id", "=", userId)
      .executeTakeFirst()

    if (!cred) {
      return { status: "error", message: "Credential not found" }
    }

    const userKey = await this.ensureUserKey(userId)
    let token: string

    try {
      if (cred.credential_type === "api_key" && cred.api_key_enc) {
        token = decryptCredential(cred.api_key_enc, userKey)
      } else if (cred.credential_type === "oauth" && cred.access_token_enc) {
        token = decryptCredential(cred.access_token_enc, userKey)
      } else {
        return { status: "error", message: "No credential data found" }
      }
    } catch {
      return { status: "error", message: "Failed to decrypt credential" }
    }

    // Check token expiry for OAuth credentials before making the call
    if (cred.token_expires_at && new Date(cred.token_expires_at) < new Date()) {
      // Attempt refresh if possible
      if (cred.refresh_token_enc) {
        const refreshed = await this.refreshToken(cred, userKey)
        if (refreshed) {
          token = refreshed
        } else {
          await this.auditLog(userId, credentialId, "connection_test", cred.provider, {
            result: "token_expired",
          })
          return {
            status: "token_expired",
            message: "Token has expired and refresh failed",
            tokenExpiresAt: cred.token_expires_at?.toISOString() ?? null,
            lastUsedAt: cred.last_used_at?.toISOString() ?? null,
          }
        }
      } else {
        await this.auditLog(userId, credentialId, "connection_test", cred.provider, {
          result: "token_expired",
        })
        return {
          status: "token_expired",
          message: "Token has expired and no refresh token is available",
          tokenExpiresAt: cred.token_expires_at?.toISOString() ?? null,
          lastUsedAt: cred.last_used_at?.toISOString() ?? null,
        }
      }
    }

    // Make a lightweight provider-specific health check
    const result = await this.pingProvider(cred.provider, token, cred.credential_type)

    // Update credential status based on test result
    if (result.status === "connected") {
      await this.db
        .updateTable("provider_credential")
        .set({
          status: "active",
          error_count: 0,
          last_error: null,
          last_used_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", credentialId)
        .execute()
    } else if (result.status === "auth_failed") {
      await this.db
        .updateTable("provider_credential")
        .set({
          status: "error",
          error_count: cred.error_count + 1,
          last_error: result.message,
          updated_at: new Date(),
        })
        .where("id", "=", credentialId)
        .execute()
    }

    await this.auditLog(userId, credentialId, "connection_test", cred.provider, {
      result: result.status,
      message: result.message,
    })

    // Reload credential for fresh timestamps
    const updated = await this.db
      .selectFrom("provider_credential")
      .select(["token_expires_at", "last_used_at"])
      .where("id", "=", credentialId)
      .executeTakeFirst()

    return {
      ...result,
      tokenExpiresAt: updated?.token_expires_at?.toISOString() ?? null,
      lastUsedAt: updated?.last_used_at?.toISOString() ?? null,
    }
  }

  /**
   * Make a lightweight API call to verify a credential works with the provider.
   */
  private async pingProvider(
    provider: string,
    token: string,
    credentialType: string,
  ): Promise<{ status: "connected" | "auth_failed" | "rate_limited" | "error"; message: string }> {
    try {
      const { url, init } = this.buildProviderPing(provider, token, credentialType)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const res = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timeout)

      if (res.ok) {
        return { status: "connected", message: "Connection successful" }
      }
      if (res.status === 401 || res.status === 403) {
        return { status: "auth_failed", message: `Authentication failed (HTTP ${res.status})` }
      }
      if (res.status === 429) {
        return { status: "rate_limited", message: "Rate limited by provider" }
      }
      return { status: "error", message: `Provider returned HTTP ${res.status}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error"
      if (msg.includes("abort")) {
        return { status: "error", message: "Connection timed out" }
      }
      return { status: "error", message: `Connection failed: ${msg}` }
    }
  }

  private buildProviderPing(
    provider: string,
    token: string,
    credentialType: string,
  ): { url: string; init: RequestInit } {
    switch (provider) {
      case "openai":
      case "openai-codex":
        return {
          url: "https://api.openai.com/v1/models",
          init: { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        }
      case "anthropic":
        return {
          url: "https://api.anthropic.com/v1/models",
          init: {
            method: "GET",
            headers: {
              ...(credentialType === "api_key"
                ? { "x-api-key": token }
                : { Authorization: `Bearer ${token}` }),
              "anthropic-version": "2023-06-01",
            },
          },
        }
      case "google-ai-studio":
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models?key=${token}`,
          init: { method: "GET" },
        }
      case "google-antigravity":
        return {
          url: "https://www.googleapis.com/oauth2/v1/tokeninfo",
          init: { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        }
      case "google-workspace":
        return {
          url: "https://www.googleapis.com/oauth2/v3/userinfo",
          init: { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        }
      case "github-user":
        return {
          url: "https://api.github.com/user",
          init: {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
          },
        }
      case "slack-user":
        return {
          url: "https://slack.com/api/auth.test",
          init: { method: "GET", headers: { Authorization: `Bearer ${token}` } },
        }
      case "brave":
        return {
          url: "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
          init: { method: "GET", headers: { "X-Subscription-Token": token } },
        }
      default:
        // Fallback: if we don't know the provider, report it
        return {
          url: "https://httpbin.org/status/200",
          init: { method: "GET" },
        }
    }
  }

  private async auditAccess(cred: ProviderCredential, context?: AuditContext): Promise<void> {
    if (!context?.agentId) return
    await this.auditLog(cred.user_account_id, cred.id, "credential_accessed", cred.provider, {
      flow: "injection",
      ...(context.agentId && { agent_id: context.agentId }),
      ...(context.jobId && { job_id: context.jobId }),
      ...(context.toolName && { tool_name: context.toolName }),
    })
  }

  private async auditLog(
    userId: string,
    credentialId: string | null,
    eventType: string,
    provider: string | null,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const entry: NewCredentialAuditLog = {
      user_account_id: userId,
      provider_credential_id: credentialId,
      event_type: eventType,
      provider,
      details,
    }

    await this.db.insertInto("credential_audit_log").values(entry).execute()
  }
}
