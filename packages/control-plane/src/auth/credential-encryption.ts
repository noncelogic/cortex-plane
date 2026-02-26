/**
 * Credential Encryption Service — AES-256-GCM per-user key management.
 *
 * Each user gets a unique encryption key that is itself encrypted by
 * a master key (derived from CREDENTIAL_MASTER_KEY env var).
 *
 * Flow:
 *   1. Master key encrypts per-user keys → stored in user_account.encryption_key_enc
 *   2. Per-user key encrypts credentials → stored in provider_credential.*_enc columns
 *   3. Decryption reverses the process: master key → user key → credential plaintext
 *
 * Security:
 *   - AES-256-GCM with unique 12-byte IV per encryption
 *   - 16-byte authentication tag for integrity verification
 *   - Per-user key isolation: compromise of one user key does not affect others
 *   - Master key never stored in database
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/** Compact encrypted payload format: iv:authTag:ciphertext (all base64). */
export interface EncryptedValue {
  iv: string
  authTag: string
  ciphertext: string
}

/**
 * Derive a 256-bit master key from a passphrase via SHA-256.
 * In production, use a proper KMS or HSM. This provides a
 * reasonable baseline for self-hosted deployments.
 */
export function deriveMasterKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase).digest()
}

/**
 * Generate a random 256-bit per-user encryption key.
 */
export function generateUserKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/**
 * Encrypt plaintext with AES-256-GCM.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  }
}

/**
 * Decrypt an AES-256-GCM encrypted value.
 */
export function decrypt(payload: EncryptedValue, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64")
  const authTag = Buffer.from(payload.authTag, "base64")
  const ciphertext = Buffer.from(payload.ciphertext, "base64")

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

/**
 * Serialize an EncryptedValue to a single string for database storage.
 * Format: base64(iv).base64(authTag).base64(ciphertext)
 */
export function serializeEncrypted(value: EncryptedValue): string {
  return `${value.iv}.${value.authTag}.${value.ciphertext}`
}

/**
 * Deserialize a stored encrypted string back to an EncryptedValue.
 */
export function deserializeEncrypted(stored: string): EncryptedValue {
  const parts = stored.split(".")
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted value format")
  }
  return { iv: parts[0]!, authTag: parts[1]!, ciphertext: parts[2]! }
}

/**
 * Encrypt a per-user key with the master key for storage.
 */
export function encryptUserKey(userKey: Buffer, masterKey: Buffer): string {
  const encrypted = encrypt(userKey.toString("base64"), masterKey)
  return serializeEncrypted(encrypted)
}

/**
 * Decrypt a per-user key from its stored form using the master key.
 */
export function decryptUserKey(stored: string, masterKey: Buffer): Buffer {
  const payload = deserializeEncrypted(stored)
  const base64Key = decrypt(payload, masterKey)
  return Buffer.from(base64Key, "base64")
}

/**
 * Encrypt a credential value (token or API key) with the user's key.
 */
export function encryptCredential(plaintext: string, userKey: Buffer): string {
  const encrypted = encrypt(plaintext, userKey)
  return serializeEncrypted(encrypted)
}

/**
 * Decrypt a credential value using the user's key.
 */
export function decryptCredential(stored: string, userKey: Buffer): string {
  const payload = deserializeEncrypted(stored)
  return decrypt(payload, userKey)
}

/**
 * Mask an API key for display purposes. Shows only the last 4 characters.
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "****"
  return `${"*".repeat(key.length - 4)}${key.slice(-4)}`
}
