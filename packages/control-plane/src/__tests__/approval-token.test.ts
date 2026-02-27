import { describe, expect, it } from "vitest"

import { generateApprovalToken, hashApprovalToken, isValidTokenFormat } from "../approval/token.js"

describe("approval token generation", () => {
  it("generates a token with correct prefix and version", () => {
    const { plaintext } = generateApprovalToken()

    expect(plaintext).toMatch(/^cortex_apr_1_[A-Za-z0-9_-]+$/)
    const parts = plaintext.split("_")
    expect(parts[0]).toBe("cortex")
    expect(parts[1]).toBe("apr")
    expect(parts[2]).toBe("1")
  })

  it("generates unique tokens on each call", () => {
    const t1 = generateApprovalToken()
    const t2 = generateApprovalToken()

    expect(t1.plaintext).not.toBe(t2.plaintext)
    expect(t1.hash).not.toBe(t2.hash)
  })

  it("produces a 64-character hex SHA-256 hash", () => {
    const { hash } = generateApprovalToken()

    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("hash is deterministic for the same plaintext", () => {
    const { plaintext, hash } = generateApprovalToken()

    expect(hashApprovalToken(plaintext)).toBe(hash)
    expect(hashApprovalToken(plaintext)).toBe(hash)
  })

  it("different plaintexts produce different hashes", () => {
    const t1 = generateApprovalToken()
    const t2 = generateApprovalToken()

    expect(t1.hash).not.toBe(t2.hash)
  })
})

describe("isValidTokenFormat", () => {
  it("accepts valid token format", () => {
    const { plaintext } = generateApprovalToken()
    expect(isValidTokenFormat(plaintext)).toBe(true)
  })

  it("rejects empty string", () => {
    expect(isValidTokenFormat("")).toBe(false)
  })

  it("rejects random strings", () => {
    expect(isValidTokenFormat("not_a_token")).toBe(false)
    expect(isValidTokenFormat("some_random_text_here")).toBe(false)
  })

  it("rejects wrong prefix", () => {
    expect(isValidTokenFormat("wrong_apr_1_abc123")).toBe(false)
  })

  it("rejects wrong version", () => {
    expect(isValidTokenFormat("cortex_apr_2_abc123")).toBe(false)
    expect(isValidTokenFormat("cortex_apr_99_abc123")).toBe(false)
  })

  it("rejects missing parts", () => {
    expect(isValidTokenFormat("cortex_apr")).toBe(false)
    expect(isValidTokenFormat("cortex_apr_1")).toBe(false)
  })
})
