/**
 * API Key Management
 *
 * Parses API key configuration from environment or config,
 * stores keys as SHA-256 hashes, and performs constant-time
 * lookups by hash comparison.
 *
 * Environment format (CORTEX_API_KEYS):
 *   JSON array of { key, userId, roles, label } objects.
 *   The plaintext `key` is hashed on load and never stored.
 */

import { createHash, timingSafeEqual } from "node:crypto"

import type { ApiKeyRecord, AuthConfig } from "./types.js"

/**
 * Hash a plaintext API key with SHA-256.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex")
}

interface RawApiKeyEntry {
  key: string
  userId: string
  roles: string[]
  label: string
}

/**
 * Load auth configuration from environment variables.
 *
 * Reads CORTEX_API_KEYS (JSON array) and hashes each key.
 * If CORTEX_REQUIRE_AUTH is "false" (or unset in dev), auth is optional.
 */
export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const rawKeys = env.CORTEX_API_KEYS
  const apiKeys: ApiKeyRecord[] = []

  if (rawKeys) {
    try {
      const entries: RawApiKeyEntry[] = JSON.parse(rawKeys)
      for (const entry of entries) {
        if (!entry.key || !entry.userId || !Array.isArray(entry.roles)) {
          continue // skip malformed entries
        }
        apiKeys.push({
          keyHash: hashApiKey(entry.key),
          userId: entry.userId,
          roles: entry.roles,
          label: entry.label ?? "unlabeled",
        })
      }
    } catch {
      // Invalid JSON — log warning, proceed with empty keys
    }
  }

  const requireAuth = env.CORTEX_REQUIRE_AUTH !== "false" && apiKeys.length > 0

  return { apiKeys, requireAuth }
}

/**
 * Look up an API key by comparing its SHA-256 hash against stored hashes.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function findApiKey(
  plaintextKey: string,
  apiKeys: ApiKeyRecord[],
): ApiKeyRecord | undefined {
  const incomingHash = hashApiKey(plaintextKey)
  const incomingBuf = Buffer.from(incomingHash, "hex")

  for (const record of apiKeys) {
    const storedBuf = Buffer.from(record.keyHash, "hex")
    if (incomingBuf.length === storedBuf.length && timingSafeEqual(incomingBuf, storedBuf)) {
      return record
    }
  }

  return undefined
}
