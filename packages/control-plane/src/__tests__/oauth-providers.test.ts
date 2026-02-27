import { describe, expect, it } from "vitest"

import {
  CODE_PASTE_PROVIDERS,
  getCodePasteProvider,
  listCodePasteProviders,
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
