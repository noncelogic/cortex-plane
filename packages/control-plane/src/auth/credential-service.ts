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

import type { Kysely } from "kysely"

import type { AuthOAuthConfig, OAuthProviderConfig } from "../config.js"
import type {
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
import { refreshAccessToken, type TokenResponse } from "./oauth-service.js"

/** Provider metadata for the "Connected Providers" UI. */
export interface ProviderInfo {
  id: string
  name: string
  authType: "oauth" | "api_key"
  description: string
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
    authType: "api_key",
    description: "Claude models via direct API key",
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
]

/** Credential summary returned to the dashboard (no secrets). */
export interface CredentialSummary {
  id: string
  provider: string
  credentialType: "oauth" | "api_key"
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
    opts?: { accountId?: string; displayLabel?: string; scopes?: string[] },
  ): Promise<CredentialSummary> {
    const userKey = await this.ensureUserKey(userId)

    const values: NewProviderCredential = {
      user_account_id: userId,
      provider,
      credential_type: "oauth",
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
    opts?: { displayLabel?: string },
  ): Promise<CredentialSummary> {
    const userKey = await this.ensureUserKey(userId)

    const values: NewProviderCredential = {
      user_account_id: userId,
      provider,
      credential_type: "api_key",
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
   */
  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    const creds = await this.db
      .selectFrom("provider_credential")
      .selectAll()
      .where("user_account_id", "=", userId)
      .orderBy("provider", "asc")
      .orderBy("created_at", "asc")
      .execute()

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

    await this.db.deleteFrom("provider_credential").where("id", "=", credentialId).execute()

    const eventType = cred.credential_type === "oauth" ? "oauth_disconnected" : "credential_deleted"
    await this.auditLog(userId, credentialId, eventType, cred.provider)
  }

  /**
   * Get a decrypted access token for a provider (for backend use).
   * Handles automatic token refresh if expired.
   */
  async getAccessToken(
    userId: string,
    provider: string,
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
      await this.markUsed(cred.id)
      return { token, credentialId: cred.id }
    }

    // For OAuth, check expiry and refresh if needed
    if (cred.credential_type === "oauth" && cred.access_token_enc) {
      const isExpired =
        cred.token_expires_at &&
        new Date(cred.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000) // 5min buffer

      if (isExpired && cred.refresh_token_enc) {
        const refreshed = await this.refreshToken(cred, userKey)
        if (refreshed) {
          return { token: refreshed, credentialId: cred.id }
        }
        // Refresh failed — fall through to return current token
      }

      const token = decryptCredential(cred.access_token_enc, userKey)
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
   */
  async getAuditLog(
    userId: string,
    limit = 50,
  ): Promise<import("../db/types.js").CredentialAuditLog[]> {
    return this.db
      .selectFrom("credential_audit_log")
      .selectAll()
      .where("user_account_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute()
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
