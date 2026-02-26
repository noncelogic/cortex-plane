import { describe, expect, it } from "vitest"

import {
  decodeOAuthState,
  encodeOAuthState,
  generateCodeChallenge,
  generateCodeVerifier,
  type OAuthState,
} from "../auth/oauth-service.js"

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("PKCE code verifier/challenge", () => {
  it("generateCodeVerifier returns a URL-safe string of correct length", () => {
    const verifier = generateCodeVerifier()
    expect(typeof verifier).toBe("string")
    // Base64url: [A-Za-z0-9_-]
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    // RFC 7636: 43–128 characters
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it("each verifier is unique", () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a).not.toBe(b)
  })

  it("generateCodeChallenge produces a different value than the verifier", () => {
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)
    expect(challenge).not.toBe(verifier)
    // Should be base64url
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("same verifier always produces same challenge (deterministic S256)", () => {
    const verifier = "test-verifier-12345678901234567890123456789012345"
    const a = generateCodeChallenge(verifier)
    const b = generateCodeChallenge(verifier)
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// OAuth state parameter
// ---------------------------------------------------------------------------

describe("OAuth state encoding/decoding", () => {
  const secret = "test-secret-key-for-hmac"

  it("round-trips state through encode → decode", () => {
    const state: OAuthState = {
      nonce: "abc-123",
      provider: "google",
      flow: "login",
    }

    const encoded = encodeOAuthState(state, secret)
    expect(typeof encoded).toBe("string")
    expect(encoded.length).toBeGreaterThan(0)

    const decoded = decodeOAuthState(encoded, secret)
    expect(decoded).not.toBeNull()
    expect(decoded!.nonce).toBe("abc-123")
    expect(decoded!.provider).toBe("google")
    expect(decoded!.flow).toBe("login")
  })

  it("decode returns null for tampered state", () => {
    const state: OAuthState = { nonce: "x", provider: "github", flow: "login" }
    const encoded = encodeOAuthState(state, secret)

    // Tamper with the encoded string
    const tampered = encoded.slice(0, -5) + "XXXXX"
    const decoded = decodeOAuthState(tampered, secret)
    expect(decoded).toBeNull()
  })

  it("decode returns null for wrong secret", () => {
    const state: OAuthState = { nonce: "x", provider: "google", flow: "connect" }
    const encoded = encodeOAuthState(state, secret)

    const decoded = decodeOAuthState(encoded, "wrong-secret")
    expect(decoded).toBeNull()
  })

  it("decode returns null for garbage input", () => {
    expect(decodeOAuthState("not-valid-base64!!!", secret)).toBeNull()
    expect(decodeOAuthState("", secret)).toBeNull()
  })

  it("preserves optional codeVerifier field", () => {
    const state: OAuthState = {
      nonce: "n",
      provider: "openai-codex",
      flow: "connect",
      codeVerifier: "my-verifier-value",
    }
    const encoded = encodeOAuthState(state, secret)
    const decoded = decodeOAuthState(encoded, secret)
    expect(decoded!.codeVerifier).toBe("my-verifier-value")
  })
})
