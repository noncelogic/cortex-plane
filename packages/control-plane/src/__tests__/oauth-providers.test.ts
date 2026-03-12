import { describe, expect, it } from "vitest"

import {
  CODE_PASTE_PROVIDERS,
  getCodePasteProvider,
  getUserServiceProvider,
  isUserServiceProvider,
  listCodePasteProviders,
  listUserServiceProviders,
  USER_SERVICE_PROVIDERS,
} from "../auth/oauth-providers.js"
import { generateCodeChallenge, generateCodeVerifier } from "../auth/oauth-service.js"

describe("oauth-providers registry", () => {
  it("contains google-antigravity, openai-codex, and anthropic", () => {
    const ids = Object.keys(CODE_PASTE_PROVIDERS)
    expect(ids).toContain("google-antigravity")
    expect(ids).toContain("openai-codex")
    expect(ids).toContain("anthropic")
  })

  it("getCodePasteProvider returns config for known providers", () => {
    const ag = getCodePasteProvider("google-antigravity")
    expect(ag).toBeDefined()
    expect(ag!.clientId).toBeTruthy()
    expect(ag!.redirectUri).toContain("localhost")

    const codex = getCodePasteProvider("openai-codex")
    expect(codex).toBeDefined()
    expect(codex!.authUrl).toContain("openai.com")

    const anth = getCodePasteProvider("anthropic")
    expect(anth).toBeDefined()
    expect(anth!.authUrl).toContain("claude.ai")
    expect(anth!.useJsonTokenExchange).toBe(true)
  })

  it("getCodePasteProvider returns undefined for unknown provider", () => {
    expect(getCodePasteProvider("unknown-provider")).toBeUndefined()
  })

  it("listCodePasteProviders returns all providers", () => {
    const list = listCodePasteProviders()
    expect(list.length).toBe(3)
    expect(list.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "google-antigravity",
      "openai-codex",
    ])
  })

  it("all providers have usePkce enabled", () => {
    for (const provider of listCodePasteProviders()) {
      expect(provider.usePkce).toBe(true)
    }
  })

  it("openai-codex scopes include model.request for API access", () => {
    const codex = getCodePasteProvider("openai-codex")!
    expect(codex.scopes).toContain("model.request")
  })

  it("anthropic is the only codePasteOnly provider", () => {
    const codePasteOnly = listCodePasteProviders().filter((p) => p.codePasteOnly)
    expect(codePasteOnly).toHaveLength(1)
    expect(codePasteOnly[0]!.id).toBe("anthropic")
  })

  it("anthropic redirectUri is not localhost (device-code flow)", () => {
    const anth = getCodePasteProvider("anthropic")!
    expect(anth.redirectUri).not.toContain("localhost")
    expect(anth.redirectUri).toContain("console.anthropic.com")
  })
})

describe("code-paste init flow builds correct OAuth URL", () => {
  it("builds Antigravity OAuth URL with PKCE and all scopes", () => {
    const provider = getCodePasteProvider("google-antigravity")!
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    const url = new URL(provider.authUrl)
    url.searchParams.set("client_id", provider.clientId)
    url.searchParams.set("redirect_uri", provider.redirectUri)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", provider.scopes.join(" "))
    url.searchParams.set("code_challenge", codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")

    expect(url.origin).toBe("https://accounts.google.com")
    expect(url.searchParams.get("client_id")).toBe(provider.clientId)
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback")
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge)
    expect(url.searchParams.get("scope")).toContain("cloud-platform")
    expect(url.searchParams.get("scope")).toContain("cclog")
  })

  it("builds Anthropic OAuth URL with code=true param", () => {
    const provider = getCodePasteProvider("anthropic")!
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)

    const url = new URL(provider.authUrl)
    url.searchParams.set("client_id", provider.clientId)
    url.searchParams.set("redirect_uri", provider.redirectUri)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("scope", provider.scopes.join(" "))
    url.searchParams.set("code_challenge", codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
    if (provider.extraAuthParams) {
      for (const [key, value] of Object.entries(provider.extraAuthParams)) {
        url.searchParams.set(key, value)
      }
    }

    expect(url.origin).toBe("https://claude.ai")
    expect(url.searchParams.get("code")).toBe("true")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://console.anthropic.com/oauth/code/callback",
    )
    expect(url.searchParams.get("scope")).toContain("org:create_api_key")
  })
})

// ---------------------------------------------------------------------------
// User service provider registry
// ---------------------------------------------------------------------------

describe("user-service-providers registry", () => {
  it("contains google-workspace, github-user, and slack-user", () => {
    const ids = Object.keys(USER_SERVICE_PROVIDERS)
    expect(ids).toContain("google-workspace")
    expect(ids).toContain("github-user")
    expect(ids).toContain("slack-user")
  })

  it("all user service providers have credentialClass = user_service", () => {
    for (const provider of listUserServiceProviders()) {
      expect(provider.credentialClass).toBe("user_service")
    }
  })

  it("getUserServiceProvider returns config for known providers", () => {
    const gw = getUserServiceProvider("google-workspace")
    expect(gw).toBeDefined()
    expect(gw!.name).toBe("Google Workspace")
    expect(gw!.defaultScopes).toContain("https://www.googleapis.com/auth/calendar.readonly")
    expect(gw!.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.send")
    expect(gw!.usePkce).toBe(true)

    const gh = getUserServiceProvider("github-user")
    expect(gh).toBeDefined()
    expect(gh!.name).toBe("GitHub (user)")
    expect(gh!.defaultScopes).toContain("repo")
    expect(gh!.usePkce).toBe(false)

    const sl = getUserServiceProvider("slack-user")
    expect(sl).toBeDefined()
    expect(sl!.name).toBe("Slack (user)")
    expect(sl!.defaultScopes).toContain("channels:read")
    expect(sl!.usePkce).toBe(false)
  })

  it("getUserServiceProvider returns undefined for unknown provider", () => {
    expect(getUserServiceProvider("unknown-provider")).toBeUndefined()
  })

  it("getUserServiceProvider returns undefined for LLM providers", () => {
    expect(getUserServiceProvider("google-antigravity")).toBeUndefined()
    expect(getUserServiceProvider("openai-codex")).toBeUndefined()
  })

  it("listUserServiceProviders returns all user service providers", () => {
    const list = listUserServiceProviders()
    expect(list.length).toBe(3)
    expect(list.map((p) => p.id).sort()).toEqual(["github-user", "google-workspace", "slack-user"])
  })

  it("isUserServiceProvider correctly identifies provider types", () => {
    expect(isUserServiceProvider("google-workspace")).toBe(true)
    expect(isUserServiceProvider("github-user")).toBe(true)
    expect(isUserServiceProvider("slack-user")).toBe(true)
    expect(isUserServiceProvider("google-antigravity")).toBe(false)
    expect(isUserServiceProvider("openai-codex")).toBe(false)
    expect(isUserServiceProvider("unknown")).toBe(false)
  })

  it("Google Workspace and Google Antigravity are distinct providers", () => {
    const workspace = getUserServiceProvider("google-workspace")
    const antigravity = getCodePasteProvider("google-antigravity")

    expect(workspace).toBeDefined()
    expect(antigravity).toBeDefined()

    // Different credential classes
    expect(workspace!.credentialClass).toBe("user_service")
    // Antigravity is an LLM provider (code-paste flow, no credentialClass field)

    // Different scopes
    expect(workspace!.defaultScopes).toContain("https://www.googleapis.com/auth/calendar.readonly")
    expect(antigravity!.scopes).toContain("https://www.googleapis.com/auth/cloud-platform")
    expect(antigravity!.scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly")
  })
})
