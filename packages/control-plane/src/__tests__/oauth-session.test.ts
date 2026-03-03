import { describe, expect, it } from "vitest"

import {
  buildAuthorizeUrl,
  decodeOAuthState,
  encodeOAuthState,
  generateCodeChallenge,
  generateCodeVerifier,
  type OAuthState,
} from "../auth/oauth-service.js"
import type { OAuthProviderConfig } from "../config.js"

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

// ---------------------------------------------------------------------------
// buildAuthorizeUrl for user service providers
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl — user service providers", () => {
  const mockConfig: OAuthProviderConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  }

  it("builds Google Workspace OAuth URL with calendar/gmail scopes", () => {
    const url = buildAuthorizeUrl({
      provider: "google-workspace",
      config: mockConfig,
      callbackUrl: "http://localhost:3100/api/auth/connect/callback/google-workspace",
      state: "test-state",
    })

    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://accounts.google.com")
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id")
    expect(parsed.searchParams.get("scope")).toContain("calendar.readonly")
    expect(parsed.searchParams.get("scope")).toContain("gmail.send")
    expect(parsed.searchParams.get("scope")).toContain("drive.readonly")
    expect(parsed.searchParams.get("access_type")).toBe("offline")
    expect(parsed.searchParams.get("prompt")).toBe("consent")
  })

  it("builds Google Workspace URL with PKCE when challenge is provided", () => {
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)

    const url = buildAuthorizeUrl({
      provider: "google-workspace",
      config: mockConfig,
      callbackUrl: "http://localhost:3100/callback",
      state: "test-state",
      codeChallenge: challenge,
    })

    const parsed = new URL(url)
    expect(parsed.searchParams.get("code_challenge")).toBe(challenge)
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256")
  })

  it("builds GitHub user OAuth URL with repo scopes", () => {
    const url = buildAuthorizeUrl({
      provider: "github-user",
      config: mockConfig,
      callbackUrl: "http://localhost:3100/api/auth/connect/callback/github-user",
      state: "test-state",
    })

    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://github.com")
    expect(parsed.searchParams.get("scope")).toContain("repo")
    expect(parsed.searchParams.get("scope")).toContain("read:user")
    expect(parsed.searchParams.get("scope")).toContain("user:email")
  })

  it("builds Slack user OAuth URL with user_scope param", () => {
    const url = buildAuthorizeUrl({
      provider: "slack-user",
      config: mockConfig,
      callbackUrl: "http://localhost:3100/api/auth/connect/callback/slack-user",
      state: "test-state",
    })

    const parsed = new URL(url)
    expect(parsed.origin).toBe("https://slack.com")
    expect(parsed.searchParams.get("user_scope")).toContain("channels:read")
    expect(parsed.searchParams.get("user_scope")).toContain("chat:write")
    expect(parsed.searchParams.get("user_scope")).toContain("users:read")
  })

  it("allows custom scopes to override defaults", () => {
    const url = buildAuthorizeUrl({
      provider: "google-workspace",
      config: mockConfig,
      callbackUrl: "http://localhost:3100/callback",
      state: "test-state",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    })

    const parsed = new URL(url)
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar")
  })
})
