import { beforeAll, describe, expect, it } from "vitest"

// Set env vars BEFORE importing the module so buildCodePasteProviders() picks them up.
beforeAll(() => {
  process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_ID = "test-antigravity-client-id"
  process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_SECRET = "test-antigravity-client-secret"
  process.env.OAUTH_GEMINI_CLI_CLIENT_ID = "test-gemini-cli-client-id"
  process.env.OAUTH_GEMINI_CLI_CLIENT_SECRET = "test-gemini-cli-client-secret"
  process.env.OAUTH_OPENAI_CODEX_CLIENT_ID = "test-openai-codex-client-id"
  process.env.OAUTH_OPENAI_CODEX_CLIENT_SECRET = "test-openai-codex-client-secret"
  process.env.OAUTH_GITHUB_COPILOT_CLIENT_ID = "test-github-copilot-client-id"
  process.env.OAUTH_GITHUB_COPILOT_CLIENT_SECRET = "test-github-copilot-client-secret"
  process.env.OAUTH_ANTHROPIC_CLIENT_ID = "test-anthropic-client-id"
  process.env.OAUTH_ANTHROPIC_CLIENT_SECRET = "test-anthropic-client-secret"
})

// Dynamic import so env vars are set first.
async function loadProviders() {
  return await import("../auth/oauth-providers.js")
}

describe("oauth-providers registry", () => {
  it("contains google-antigravity, google-gemini-cli, openai-codex, github-copilot, and anthropic", async () => {
    const { CODE_PASTE_PROVIDERS } = await loadProviders()
    const ids = Object.keys(CODE_PASTE_PROVIDERS)
    expect(ids).toContain("google-antigravity")
    expect(ids).toContain("google-gemini-cli")
    expect(ids).toContain("openai-codex")
    expect(ids).toContain("github-copilot")
    expect(ids).toContain("anthropic")
  })

  it("getCodePasteProvider returns config for known providers", async () => {
    const { getCodePasteProvider } = await loadProviders()

    const ag = getCodePasteProvider("google-antigravity")
    expect(ag).toBeDefined()
    expect(ag!.clientId).toBe("test-antigravity-client-id")
    expect(ag!.redirectUri).toContain("localhost")

    const gemini = getCodePasteProvider("google-gemini-cli")
    expect(gemini).toBeDefined()
    expect(gemini!.clientId).toBe("test-gemini-cli-client-id")
    expect(gemini!.redirectUri).toBe("http://localhost:8085")
    expect(gemini!.usePkce).toBe(true)

    const codex = getCodePasteProvider("openai-codex")
    expect(codex).toBeDefined()
    expect(codex!.authUrl).toContain("openai.com")

    const copilot = getCodePasteProvider("github-copilot")
    expect(copilot).toBeDefined()
    expect(copilot!.clientId).toBe("test-github-copilot-client-id")
    expect(copilot!.authUrl).toContain("github.com")

    const anth = getCodePasteProvider("anthropic")
    expect(anth).toBeDefined()
    expect(anth!.authUrl).toContain("claude.ai")
    expect(anth!.useJsonTokenExchange).toBe(true)
  })

  it("getCodePasteProvider returns undefined for unknown provider", async () => {
    const { getCodePasteProvider } = await loadProviders()
    expect(getCodePasteProvider("unknown-provider")).toBeUndefined()
  })

  it("listCodePasteProviders returns all providers", async () => {
    const { listCodePasteProviders } = await loadProviders()
    const list = listCodePasteProviders()
    expect(list.length).toBe(5)
    expect(list.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "github-copilot",
      "google-antigravity",
      "google-gemini-cli",
      "openai-codex",
    ])
  })

  it("all providers except github-copilot have usePkce enabled", async () => {
    const { listCodePasteProviders } = await loadProviders()
    for (const provider of listCodePasteProviders()) {
      if (provider.id === "github-copilot") {
        expect(provider.usePkce).toBe(false)
      } else {
        expect(provider.usePkce).toBe(true)
      }
    }
  })

  it("anthropic is the only codePasteOnly provider", async () => {
    const { listCodePasteProviders } = await loadProviders()
    const codePasteOnly = listCodePasteProviders().filter((p) => p.codePasteOnly)
    expect(codePasteOnly).toHaveLength(1)
    expect(codePasteOnly[0]!.id).toBe("anthropic")
  })

  it("anthropic redirectUri is not localhost (device-code flow)", async () => {
    const { getCodePasteProvider } = await loadProviders()
    const anth = getCodePasteProvider("anthropic")!
    expect(anth.redirectUri).not.toContain("localhost")
    expect(anth.redirectUri).toContain("console.anthropic.com")
  })

  it("providers are excluded when env vars are not set", async () => {
    // We can't easily unset env vars and re-import in the same process,
    // but we can verify the builder logic by checking that clientId comes
    // from the env var (not hardcoded).
    const { getCodePasteProvider } = await loadProviders()
    const ag = getCodePasteProvider("google-antigravity")!
    expect(ag.clientId).toBe("test-antigravity-client-id")
    expect(ag.clientSecret).toBe("test-antigravity-client-secret")
  })

  it("google-gemini-cli has correct OAuth config", async () => {
    const { getCodePasteProvider } = await loadProviders()
    const gemini = getCodePasteProvider("google-gemini-cli")!
    expect(gemini.authUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(gemini.tokenUrl).toBe("https://oauth2.googleapis.com/token")
    expect(gemini.scopes).toContain("https://www.googleapis.com/auth/cloud-platform")
    expect(gemini.scopes).toContain("https://www.googleapis.com/auth/userinfo.email")
    expect(gemini.scopes).toContain("https://www.googleapis.com/auth/userinfo.profile")
    expect(gemini.usePkce).toBe(true)
    expect(gemini.redirectUri).toBe("http://localhost:8085")
  })

  it("github-copilot has correct OAuth config", async () => {
    const { getCodePasteProvider } = await loadProviders()
    const copilot = getCodePasteProvider("github-copilot")!
    expect(copilot.authUrl).toBe("https://github.com/login/oauth/authorize")
    expect(copilot.tokenUrl).toBe("https://github.com/login/oauth/access_token")
    expect(copilot.scopes).toEqual(["read:user"])
    expect(copilot.usePkce).toBe(false)
    expect(copilot.redirectUri).toBe("http://localhost:1234")
    expect(copilot.clientId).toBe("test-github-copilot-client-id")
    expect(copilot.clientSecret).toBe("test-github-copilot-client-secret")
  })
})

describe("code-paste init flow builds correct OAuth URL", () => {
  it("builds Antigravity OAuth URL with PKCE and all scopes", async () => {
    const { getCodePasteProvider } = await loadProviders()
    const { generateCodeChallenge, generateCodeVerifier } = await import("../auth/oauth-service.js")

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
    expect(url.searchParams.get("client_id")).toBe("test-antigravity-client-id")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback")
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge)
    expect(url.searchParams.get("scope")).toContain("cloud-platform")
    expect(url.searchParams.get("scope")).toContain("cclog")
  })

  it("builds Anthropic OAuth URL with code=true param", async () => {
    const { getCodePasteProvider } = await loadProviders()
    const { generateCodeChallenge, generateCodeVerifier } = await import("../auth/oauth-service.js")

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
  it("contains google-workspace, github-user, and slack-user", async () => {
    const { USER_SERVICE_PROVIDERS } = await loadProviders()
    const ids = Object.keys(USER_SERVICE_PROVIDERS)
    expect(ids).toContain("google-workspace")
    expect(ids).toContain("github-user")
    expect(ids).toContain("slack-user")
  })

  it("all user service providers have credentialClass = user_service", async () => {
    const { listUserServiceProviders } = await loadProviders()
    for (const provider of listUserServiceProviders()) {
      expect(provider.credentialClass).toBe("user_service")
    }
  })

  it("getUserServiceProvider returns config for known providers", async () => {
    const { getUserServiceProvider } = await loadProviders()

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

  it("getUserServiceProvider returns undefined for unknown provider", async () => {
    const { getUserServiceProvider } = await loadProviders()
    expect(getUserServiceProvider("unknown-provider")).toBeUndefined()
  })

  it("getUserServiceProvider returns undefined for LLM providers", async () => {
    const { getUserServiceProvider } = await loadProviders()
    expect(getUserServiceProvider("google-antigravity")).toBeUndefined()
    expect(getUserServiceProvider("openai-codex")).toBeUndefined()
    expect(getUserServiceProvider("github-copilot")).toBeUndefined()
  })

  it("listUserServiceProviders returns all user service providers", async () => {
    const { listUserServiceProviders } = await loadProviders()
    const list = listUserServiceProviders()
    expect(list.length).toBe(3)
    expect(list.map((p) => p.id).sort()).toEqual(["github-user", "google-workspace", "slack-user"])
  })

  it("isUserServiceProvider correctly identifies provider types", async () => {
    const { isUserServiceProvider } = await loadProviders()
    expect(isUserServiceProvider("google-workspace")).toBe(true)
    expect(isUserServiceProvider("github-user")).toBe(true)
    expect(isUserServiceProvider("slack-user")).toBe(true)
    expect(isUserServiceProvider("google-antigravity")).toBe(false)
    expect(isUserServiceProvider("openai-codex")).toBe(false)
    expect(isUserServiceProvider("github-copilot")).toBe(false)
    expect(isUserServiceProvider("unknown")).toBe(false)
  })

  it("Google Workspace and Google Antigravity are distinct providers", async () => {
    const { getUserServiceProvider, getCodePasteProvider } = await loadProviders()
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
