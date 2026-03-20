import { describe, expect, it } from "vitest"

import type { Credential, ProviderInfo } from "@/lib/api-client"

/**
 * Tests for provider-driven OAuth flow selection used in the settings page.
 * This mirrors the OpenClaw-style provider registry contract instead of
 * hardcoding provider IDs in the dashboard.
 */

function shouldSkipOAuthPopup(provider: ProviderInfo): boolean {
  return provider.oauthConnectMode === "code_paste"
}

function usesRedirectOAuth(provider: ProviderInfo): boolean {
  return provider.authType === "oauth" && provider.oauthConnectMode === "redirect"
}

/**
 * credentialLabel — mirrors the helper in settings/page.tsx.
 * Duplicated here so we can test without importing the React component.
 */
function credentialLabel(cred: Credential, providers: ProviderInfo[]): string {
  if (cred.displayLabel) return cred.displayLabel
  return providers.find((p) => p.id === cred.provider)?.name ?? cred.provider
}

describe("settings page OAuth connect modes", () => {
  it("routes Anthropic to direct code-paste without opening a popup", () => {
    expect(
      shouldSkipOAuthPopup({
        id: "anthropic",
        name: "Anthropic",
        authType: "oauth",
        description: "Claude models",
        oauthConnectMode: "code_paste",
      }),
    ).toBe(true)
  })

  it("routes Google Antigravity to popup capture flow", () => {
    expect(
      shouldSkipOAuthPopup({
        id: "google-antigravity",
        name: "Google Antigravity",
        authType: "oauth",
        description: "Claude/Gemini via Google Cloud Antigravity",
        oauthConnectMode: "popup",
      }),
    ).toBe(false)
  })

  it("routes Google Workspace to redirect-based OAuth", () => {
    expect(
      usesRedirectOAuth({
        id: "google-workspace",
        name: "Google Workspace",
        authType: "oauth",
        description: "Google services",
        credentialClass: "user_service",
        oauthConnectMode: "redirect",
      }),
    ).toBe(true)
  })

  it("does not route API key providers through OAuth helpers", () => {
    expect(
      usesRedirectOAuth({
        id: "openai",
        name: "OpenAI",
        authType: "api_key",
        description: "GPT models",
      }),
    ).toBe(false)
    expect(
      shouldSkipOAuthPopup({
        id: "openai",
        name: "OpenAI",
        authType: "api_key",
        description: "GPT models",
      }),
    ).toBe(false)
  })

  it("keeps popup-capable OAuth providers on the popup path", () => {
    expect(
      usesRedirectOAuth({
        id: "github-copilot",
        name: "GitHub Copilot",
        authType: "oauth",
        description: "GPT/Claude models via GitHub Copilot subscription",
        oauthConnectMode: "popup",
      }),
    ).toBe(false)
    expect(
      shouldSkipOAuthPopup({
        id: "github-copilot",
        name: "GitHub Copilot",
        authType: "oauth",
        description: "GPT/Claude models via GitHub Copilot subscription",
        oauthConnectMode: "popup",
      }),
    ).toBe(false)
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

// ---------------------------------------------------------------------------
// LLM provider filtering — mirrors the filter in settings/page.tsx
// ---------------------------------------------------------------------------

describe("settings page LLM provider filter", () => {
  const ALL_PROVIDERS: ProviderInfo[] = [
    { id: "openai", name: "OpenAI", authType: "api_key", description: "GPT models" },
    { id: "anthropic", name: "Anthropic", authType: "oauth", description: "Claude models" },
    {
      id: "google-workspace",
      name: "Google Workspace",
      authType: "oauth",
      description: "Google services",
      credentialClass: "user_service",
    },
    {
      id: "brave",
      name: "Brave Search",
      authType: "api_key",
      description: "Web search",
      credentialClass: "tool_specific",
    },
    {
      id: "google-ai-studio",
      name: "Google AI Studio",
      authType: "api_key",
      description: "Gemini",
      credentialClass: "llm_provider",
    },
  ]

  function filterLlmProviders(providers: ProviderInfo[]): ProviderInfo[] {
    return providers.filter((p) => !p.credentialClass || p.credentialClass === "llm_provider")
  }

  it("includes providers without credentialClass (legacy LLM providers)", () => {
    const result = filterLlmProviders(ALL_PROVIDERS)
    expect(result.map((p) => p.id)).toContain("openai")
    expect(result.map((p) => p.id)).toContain("anthropic")
  })

  it("includes providers with credentialClass === 'llm_provider'", () => {
    const result = filterLlmProviders(ALL_PROVIDERS)
    expect(result.map((p) => p.id)).toContain("google-ai-studio")
  })

  it("excludes user_service providers", () => {
    const result = filterLlmProviders(ALL_PROVIDERS)
    expect(result.map((p) => p.id)).not.toContain("google-workspace")
  })

  it("excludes tool_specific providers", () => {
    const result = filterLlmProviders(ALL_PROVIDERS)
    expect(result.map((p) => p.id)).not.toContain("brave")
  })

  it("returns correct count", () => {
    const result = filterLlmProviders(ALL_PROVIDERS)
    expect(result).toHaveLength(3)
  })
})
