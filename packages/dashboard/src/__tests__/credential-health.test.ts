import { describe, expect, it } from "vitest"

import type { Credential } from "@/lib/api-client"
import { errorSummary, refreshStatus, tokenExpiry } from "@/lib/credential-health"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    provider: "openai",
    credentialType: "api_key",
    displayLabel: null,
    maskedKey: "****1234",
    status: "active",
    lastUsedAt: null,
    requiresReauth: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// tokenExpiry
// ---------------------------------------------------------------------------

describe("tokenExpiry", () => {
  const now = new Date("2026-03-09T12:00:00.000Z")

  it("returns null when tokenExpiresAt is absent", () => {
    expect(tokenExpiry(makeCred(), now)).toBeNull()
  })

  it("returns null when tokenExpiresAt is null", () => {
    expect(tokenExpiry(makeCred({ tokenExpiresAt: null }), now)).toBeNull()
  })

  it("returns Auto-renewing for active OAuth credentials", () => {
    const cred = makeCred({
      credentialType: "oauth",
      status: "active",
      tokenExpiresAt: "2026-03-09T12:15:00.000Z",
    })
    const result = tokenExpiry(cred, now)!
    expect(result.label).toBe("Auto-renewing")
    expect(result.severity).toBe("ok")
  })

  it("returns Auto-renewing for active OAuth with errors but token not yet expired", () => {
    const cred = makeCred({
      credentialType: "oauth",
      status: "active",
      tokenExpiresAt: "2026-03-09T13:00:00.000Z",
      errorCount: 2,
      lastError: "rate_limited",
    })
    const result = tokenExpiry(cred, now)!
    expect(result.label).toBe("Auto-renewing")
    expect(result.severity).toBe("ok")
  })

  it("shows expiry when active OAuth token expired and refresh failed", () => {
    const cred = makeCred({
      credentialType: "oauth",
      status: "active",
      tokenExpiresAt: "2026-03-09T11:00:00.000Z",
      errorCount: 3,
      lastError: "token refresh failed: invalid_grant",
    })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("danger")
    expect(result.label).toMatch(/^Expired/)
  })

  it("returns expiry countdown for non-active OAuth credentials", () => {
    const cred = makeCred({
      credentialType: "oauth",
      status: "error",
      tokenExpiresAt: "2026-03-09T11:00:00.000Z",
    })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("danger")
    expect(result.label).toMatch(/^Expired/)
  })

  it("returns expiry countdown for API key credentials", () => {
    const cred = makeCred({
      credentialType: "api_key",
      status: "active",
      tokenExpiresAt: "2026-03-09T18:00:00.000Z",
    })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("warning")
    expect(result.label).toMatch(/^Expires in/)
    expect(result.label).toContain("6h")
  })

  it("returns danger when token is already expired", () => {
    const cred = makeCred({ tokenExpiresAt: "2026-03-09T11:00:00.000Z" })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("danger")
    expect(result.label).toMatch(/^Expired/)
    expect(result.label).toContain("1h")
  })

  it("returns warning when token expires within 24 hours", () => {
    // Expires in 6 hours
    const cred = makeCred({ tokenExpiresAt: "2026-03-09T18:00:00.000Z" })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("warning")
    expect(result.label).toMatch(/^Expires in/)
    expect(result.label).toContain("6h")
  })

  it("returns ok when token expires in more than 24 hours", () => {
    // Expires in 3 days
    const cred = makeCred({ tokenExpiresAt: "2026-03-12T12:00:00.000Z" })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("ok")
    expect(result.label).toMatch(/^Expires in/)
    expect(result.label).toContain("3d")
  })

  it("shows minutes for short durations", () => {
    // Expires in 30 minutes
    const cred = makeCred({ tokenExpiresAt: "2026-03-09T12:30:00.000Z" })
    const result = tokenExpiry(cred, now)!
    expect(result.severity).toBe("warning")
    expect(result.label).toBe("Expires in 30m")
  })

  it("shows <1m for very short durations", () => {
    // Expires in 30 seconds
    const cred = makeCred({ tokenExpiresAt: "2026-03-09T12:00:30.000Z" })
    const result = tokenExpiry(cred, now)!
    expect(result.label).toBe("Expires in <1m")
  })
})

// ---------------------------------------------------------------------------
// errorSummary
// ---------------------------------------------------------------------------

describe("errorSummary", () => {
  it("returns null for active credential with no errors", () => {
    expect(errorSummary(makeCred())).toBeNull()
  })

  it("returns null for active credential with errorCount 0", () => {
    expect(errorSummary(makeCred({ errorCount: 0 }))).toBeNull()
  })

  it("returns error info for status=error with error details", () => {
    const cred = makeCred({
      status: "error",
      errorCount: 3,
      lastError: "token refresh failed: invalid_grant",
    })
    const result = errorSummary(cred)!
    expect(result.label).toBe("3 consecutive failures")
    expect(result.message).toBe("token refresh failed: invalid_grant")
  })

  it("returns singular form for 1 failure", () => {
    const cred = makeCred({
      status: "error",
      errorCount: 1,
      lastError: "timeout",
    })
    const result = errorSummary(cred)!
    expect(result.label).toBe("1 consecutive failure")
  })

  it("returns status label when error/expired with no details", () => {
    const cred = makeCred({ status: "expired", errorCount: 0, requiresReauth: true })
    const result = errorSummary(cred)!
    expect(result.label).toBe("Reconnect required")
  })

  it("returns status label for revoked credentials", () => {
    const cred = makeCred({ status: "revoked", requiresReauth: true })
    const result = errorSummary(cred)!
    expect(result.label).toBe("Reconnect required")
  })

  it("shows error info for active credential with nonzero errorCount", () => {
    const cred = makeCred({
      status: "active",
      errorCount: 2,
      lastError: "rate_limited",
    })
    const result = errorSummary(cred)!
    expect(result.label).toBe("2 consecutive failures")
    expect(result.message).toBe("rate_limited")
  })
})

// ---------------------------------------------------------------------------
// refreshStatus
// ---------------------------------------------------------------------------

describe("refreshStatus", () => {
  it("returns null when lastRefreshAt is absent", () => {
    expect(refreshStatus(makeCred())).toBeNull()
  })

  it("returns null when lastRefreshAt is null", () => {
    expect(refreshStatus(makeCred({ lastRefreshAt: null }))).toBeNull()
  })

  it("returns formatted refresh timestamp", () => {
    const cred = makeCred({ lastRefreshAt: "2026-03-09T10:30:00.000Z" })
    const result = refreshStatus(cred)!
    expect(result).toMatch(/^Last refreshed:/)
  })
})
