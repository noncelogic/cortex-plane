import { describe, expect, it } from "vitest"

import {
  decryptCredential,
  decryptUserKey,
  deriveMasterKey,
  encryptCredential,
  encryptUserKey,
  generateUserKey,
  maskApiKey,
} from "../auth/credential-encryption.js"

// ---------------------------------------------------------------------------
// deriveMasterKey
// ---------------------------------------------------------------------------

describe("deriveMasterKey", () => {
  it("produces a 32-byte Buffer from a passphrase", () => {
    const key = deriveMasterKey("test-passphrase")
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it("is deterministic", () => {
    const a = deriveMasterKey("hello")
    const b = deriveMasterKey("hello")
    expect(a.equals(b)).toBe(true)
  })

  it("different passphrases produce different keys", () => {
    const a = deriveMasterKey("aaa")
    const b = deriveMasterKey("bbb")
    expect(a.equals(b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// generateUserKey + encrypt/decrypt user key
// ---------------------------------------------------------------------------

describe("user key management", () => {
  const masterKey = deriveMasterKey("test-master-key")

  it("generateUserKey returns a 32-byte Buffer", () => {
    const key = generateUserKey()
    expect(key).toBeInstanceOf(Buffer)
    expect(key.length).toBe(32)
  })

  it("each generated key is unique", () => {
    const a = generateUserKey()
    const b = generateUserKey()
    expect(a.equals(b)).toBe(false)
  })

  it("round-trips user key through encrypt → decrypt", () => {
    const original = generateUserKey()
    const encrypted = encryptUserKey(original, masterKey)
    expect(typeof encrypted).toBe("string")
    expect(encrypted).not.toBe("")

    const decrypted = decryptUserKey(encrypted, masterKey)
    expect(decrypted.equals(original)).toBe(true)
  })

  it("decrypt with wrong master key throws", () => {
    const original = generateUserKey()
    const encrypted = encryptUserKey(original, masterKey)
    const wrongKey = deriveMasterKey("wrong-key")

    expect(() => decryptUserKey(encrypted, wrongKey)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// credential encryption
// ---------------------------------------------------------------------------

describe("credential encryption", () => {
  const userKey = generateUserKey()

  it("round-trips credential data through encrypt → decrypt", () => {
    const plaintext = "sk-ant-api03-long-api-key-here"
    const encrypted = encryptCredential(plaintext, userKey)
    expect(typeof encrypted).toBe("string")
    expect(encrypted).not.toContain(plaintext)

    const decrypted = decryptCredential(encrypted, userKey)
    expect(decrypted).toBe(plaintext)
  })

  it("encrypts to different ciphertext each time (random IV)", () => {
    const plaintext = "same-data"
    const a = encryptCredential(plaintext, userKey)
    const b = encryptCredential(plaintext, userKey)
    expect(a).not.toBe(b) // Different IVs
  })

  it("decrypt with wrong key throws", () => {
    const encrypted = encryptCredential("secret", userKey)
    const wrongKey = generateUserKey()

    expect(() => decryptCredential(encrypted, wrongKey)).toThrow()
  })

  it("handles empty string", () => {
    const encrypted = encryptCredential("", userKey)
    const decrypted = decryptCredential(encrypted, userKey)
    expect(decrypted).toBe("")
  })

  it("handles unicode content", () => {
    const plaintext = "API-KEY-\u00e9\u00e8\u00ea-\u{1f512}"
    const encrypted = encryptCredential(plaintext, userKey)
    const decrypted = decryptCredential(encrypted, userKey)
    expect(decrypted).toBe(plaintext)
  })
})

// ---------------------------------------------------------------------------
// maskApiKey
// ---------------------------------------------------------------------------

describe("maskApiKey", () => {
  it("masks all but last 4 characters", () => {
    const masked = maskApiKey("sk-ant-api03-abc123xyz")
    // 22 chars total → 18 asterisks + "3xyz"
    expect(masked).toBe("******************3xyz")
  })

  it("returns asterisks for short keys", () => {
    expect(maskApiKey("ab")).toBe("****")
    expect(maskApiKey("")).toBe("****")
  })

  it("shows only last 4 chars for long keys", () => {
    const masked = maskApiKey("sk-proj-abcdefghijklmnop")
    expect(masked).toMatch(/^\*+mnop$/)
    expect(masked.endsWith("mnop")).toBe(true)
  })
})
