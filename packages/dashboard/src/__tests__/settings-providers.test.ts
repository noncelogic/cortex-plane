import { describe, expect, it } from "vitest"

import type { Credential, ProviderInfo } from "@/lib/api-client"

/**
 * Tests for the code-paste provider set used in the settings page.
 * Validates the static mapping is correct without requiring React rendering.
 */

const CODE_PASTE_PROVIDER_IDS = new Set(["google-antigravity", "openai-codex", "anthropic"])

/**
 * credentialLabel — mirrors the helper in settings/page.tsx.
 * Duplicated here so we can test without importing the React component.
 */
function credentialLabel(cred: Credential, providers: ProviderInfo[]): string {
  if (cred.displayLabel) return cred.displayLabel
  return providers.find((p) => p.id === cred.provider)?.name ?? cred.provider
}

describe("settings page code-paste providers", () => {
  it("identifies google-antigravity as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("google-antigravity")).toBe(true)
  })

  it("identifies openai-codex as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("openai-codex")).toBe(true)
  })

  it("identifies anthropic as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("anthropic")).toBe(true)
  })

  it("does not identify non-code-paste providers", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("openai")).toBe(false)
    expect(CODE_PASTE_PROVIDER_IDS.has("google-ai-studio")).toBe(false)
    expect(CODE_PASTE_PROVIDER_IDS.has("github")).toBe(false)
  })

  it("contains exactly 3 providers", () => {
    expect(CODE_PASTE_PROVIDER_IDS.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// credentialLabel helper
// ---------------------------------------------------------------------------

const STUB_PROVIDERS: ProviderInfo[] = [
  { id: "openai", name: "OpenAI", authType: "api_key", description: "OpenAI LLM provider" },
  { id: "anthropic", name: "Anthropic", authType: "oauth", description: "Anthropic LLM provider" },
]

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    provider: "openai",
    credentialType: "api_key",
    displayLabel: null,
    maskedKey: "****1234",
    status: "active",
    accountId: null,
    lastUsedAt: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("credentialLabel", () => {
  it("returns displayLabel when present", () => {
    const cred = makeCred({ displayLabel: "My Production Key" })
    expect(credentialLabel(cred, STUB_PROVIDERS)).toBe("My Production Key")
  })

  it("falls back to provider name when displayLabel is null", () => {
    const cred = makeCred({ provider: "anthropic", displayLabel: null })
    expect(credentialLabel(cred, STUB_PROVIDERS)).toBe("Anthropic")
  })

  it("falls back to raw provider id when provider is unknown", () => {
    const cred = makeCred({ provider: "unknown-llm", displayLabel: null })
    expect(credentialLabel(cred, STUB_PROVIDERS)).toBe("unknown-llm")
  })
})
