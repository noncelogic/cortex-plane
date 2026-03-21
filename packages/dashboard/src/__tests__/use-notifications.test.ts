import { describe, expect, it } from "vitest"

import { buildCredentialWarningNotification } from "@/hooks/use-notifications"
import type { Credential } from "@/lib/api-client"

function makeCredential(overrides: Partial<Credential>): Credential {
  return {
    id: "cred-1",
    provider: "anthropic",
    credentialType: "oauth",
    credentialClass: "llm_provider",
    toolName: null,
    displayLabel: "Primary",
    maskedKey: null,
    status: "active",
    accountId: null,
    scopes: null,
    tokenExpiresAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    errorCount: 0,
    lastError: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("buildCredentialWarningNotification", () => {
  it("returns null when no credential is in a warning/error state", () => {
    const now = new Date("2026-03-21T00:00:00.000Z")
    const creds: Credential[] = [
      makeCredential({
        status: "active",
        credentialType: "oauth",
        tokenExpiresAt: "2026-03-21T02:00:00.000Z",
      }),
    ]

    const notification = buildCredentialWarningNotification(creds, now)
    expect(notification).toBeNull()
  })

  it("identifies a single affected provider/credential with reason", () => {
    const now = new Date("2026-03-21T00:00:00.000Z")
    const creds: Credential[] = [
      makeCredential({
        provider: "openai",
        displayLabel: "Production Key",
        credentialType: "api_key",
        tokenExpiresAt: "2026-03-21T06:00:00.000Z",
      }),
    ]

    const notification = buildCredentialWarningNotification(creds, now)
    expect(notification).not.toBeNull()
    expect(notification?.label).toContain("openai · Production Key")
    expect(notification?.label).toContain("expires in 6h")
  })

  it("uses status-based warning when credential is already unhealthy", () => {
    const now = new Date("2026-03-21T00:00:00.000Z")
    const creds: Credential[] = [
      makeCredential({
        provider: "anthropic",
        displayLabel: "Anthropic OAuth",
        status: "expired",
        tokenExpiresAt: "2026-03-20T23:00:00.000Z",
      }),
    ]

    const notification = buildCredentialWarningNotification(creds, now)
    expect(notification?.label).toContain("anthropic · Anthropic OAuth")
    expect(notification?.label).toContain("status: expired")
  })

  it("summarizes multiple warnings while naming a concrete source", () => {
    const now = new Date("2026-03-21T00:00:00.000Z")
    const creds: Credential[] = [
      makeCredential({
        provider: "openai",
        displayLabel: "OpenAI Prod",
        credentialType: "api_key",
        tokenExpiresAt: "2026-03-21T02:00:00.000Z",
      }),
      makeCredential({
        id: "cred-2",
        provider: "anthropic",
        displayLabel: "Anthropic Team",
        status: "error",
      }),
    ]

    const notification = buildCredentialWarningNotification(creds, now)
    expect(notification?.label).toContain("openai · OpenAI Prod")
    expect(notification?.label).toContain("+1 more")
  })
})
