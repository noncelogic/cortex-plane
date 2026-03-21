/**
 * Tests for the /auth/connect/callback/:provider redirect-flow handler.
 *
 * Validates that:
 * - google-antigravity triggers Antigravity project discovery before storing tokens
 * - other providers store tokens without project discovery
 */
import Fastify from "fastify"
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDiscoverProject = vi.hoisted(() => vi.fn().mockResolvedValue("my-gcp-project-123"))
const mockExchangeCode = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    access_token: "goog-access-token",
    refresh_token: "goog-refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "cloud-platform",
  }),
)
const mockDecodeState = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    nonce: "test-nonce",
    provider: "google-antigravity",
    flow: "connect",
  }),
)

const mockGetCodePasteProvider = vi.hoisted(() =>
  vi.fn().mockImplementation((provider: string) => {
    if (provider === "google-antigravity") {
      return {
        id: "google-antigravity",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        redirectUri: "http://localhost:51121/oauth-callback",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        usePkce: true,
      }
    }
    return undefined
  }),
)

vi.mock("../auth/oauth-providers.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    getCodePasteProvider: mockGetCodePasteProvider,
  }
})

vi.mock("../auth/antigravity-project.js", () => ({
  discoverAntigravityProject: mockDiscoverProject,
}))

vi.mock("../auth/oauth-service.js", () => ({
  exchangeCodeForTokens: mockExchangeCode,
  decodeOAuthState: mockDecodeState,
  encodeOAuthState: vi.fn().mockReturnValue("encoded-state"),
  buildAuthorizeUrl: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?test"),
  fetchUserProfile: vi.fn(),
  generateCodeVerifier: vi.fn().mockReturnValue("test-verifier"),
  generateCodeChallenge: vi.fn().mockReturnValue("test-challenge"),
}))

import type { AuthOAuthConfig } from "../config.js"
import { authRoutes } from "../routes/auth.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_AUTH_CONFIG: AuthOAuthConfig = {
  credentialMasterKey: "test-master-key-32chars-minimum!",
  dashboardUrl: "http://localhost:3100",
  sessionMaxAge: 86400,
  googleWorkspace: {
    clientId: "ws-client-id",
    clientSecret: "ws-client-secret",
  },
}

function mockCredentialService() {
  return {
    storeOAuthCredential: vi.fn().mockResolvedValue({
      id: "cred-1",
      provider: "google-antigravity",
      credentialType: "oauth",
      status: "active",
    }),
    testCredential: vi.fn().mockResolvedValue({
      status: "connected",
      message: "Connection successful",
    }),
  }
}

function mockSessionService() {
  return {
    validateSession: vi.fn().mockResolvedValue({
      session: {
        id: "sess-1",
        csrf_token: "csrf-tok",
        user_account_id: "user-1",
        expires_at: new Date(Date.now() + 86400_000),
        created_at: new Date(),
        last_active_at: new Date(),
      },
      user: {
        userId: "user-1",
        role: "operator",
        displayName: "Test User",
        email: "test@example.com",
        avatarUrl: null,
      },
    }),
    validateCsrf: vi.fn().mockReturnValue(true),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  }
}

function mockDb() {
  return {
    insertInto: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue(undefined) }),
    }),
  }
}

async function buildTestApp() {
  const app = Fastify({ logger: false })
  const credentialService = mockCredentialService()
  const sessionService = mockSessionService()
  const db = mockDb()

  await app.register(
    authRoutes({
      db: db as never,
      authConfig: MOCK_AUTH_CONFIG,
      sessionService: sessionService as never,
      credentialService: credentialService as never,
    }),
  )

  return { app, credentialService, sessionService }
}

function withSession(headers: Record<string, string> = {}) {
  return { cookie: "cortex_session=sess-1", ...headers }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /auth/connect/callback/:provider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default mock return values after clearAllMocks
    mockDiscoverProject.mockResolvedValue("my-gcp-project-123")
    mockExchangeCode.mockResolvedValue({
      access_token: "goog-access-token",
      refresh_token: "goog-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "cloud-platform",
    })
    mockDecodeState.mockReturnValue({
      nonce: "test-nonce",
      provider: "google-antigravity",
      flow: "connect",
    })
  })

  it("calls discoverAntigravityProject for google-antigravity and passes accountId", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-antigravity?code=test-code&state=valid-state",
      headers: withSession(),
    })

    // Should redirect to settings with connected param
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("http://localhost:3100/settings?connected=google-antigravity")

    // discoverAntigravityProject should have been called with the access token
    expect(mockDiscoverProject).toHaveBeenCalledWith("goog-access-token")

    // storeOAuthCredential should include the discovered accountId
    expect(credentialService.storeOAuthCredential).toHaveBeenCalledWith(
      "user-1",
      "google-antigravity",
      expect.objectContaining({
        access_token: "goog-access-token",
        refresh_token: "goog-refresh-token",
      }),
      expect.objectContaining({
        accountId: "my-gcp-project-123",
      }),
    )

    // Newly stored credential is immediately verified
    expect(credentialService.testCredential).toHaveBeenCalledWith("user-1", "cred-1")
  })

  it("does NOT call discoverAntigravityProject for google-workspace", async () => {
    mockDecodeState.mockReturnValueOnce({
      nonce: "test-nonce",
      provider: "google-workspace",
      flow: "connect",
    })

    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-workspace?code=test-code&state=valid-state",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("http://localhost:3100/settings?connected=google-workspace")

    // discoverAntigravityProject must NOT have been called
    expect(mockDiscoverProject).not.toHaveBeenCalled()

    // storeOAuthCredential should have accountId undefined
    expect(credentialService.storeOAuthCredential).toHaveBeenCalledWith(
      "user-1",
      "google-workspace",
      expect.anything(),
      expect.objectContaining({
        accountId: undefined,
        credentialClass: "user_service",
      }),
    )
  })

  it("redirects to unverified error when post-connect verification fails", async () => {
    const { app, credentialService } = await buildTestApp()
    ;(
      credentialService.testCredential as { mockResolvedValueOnce: (value: unknown) => unknown }
    ).mockResolvedValueOnce({
      status: "auth_failed",
      message: "Authentication failed (HTTP 403)",
    })

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-antigravity?code=test-code&state=valid-state",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain(
      "/settings?error=connect_unverified&provider=google-antigravity",
    )
    expect(res.headers.location).toContain("reason=Authentication%20failed%20(HTTP%20403)")
  })

  it("returns 401 without auth session", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-antigravity?code=test-code&state=valid-state",
      // No session cookie
    })

    expect(res.statusCode).toBe(401)
  })

  it("redirects to settings with error on invalid state", async () => {
    mockDecodeState.mockReturnValueOnce(null)
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-antigravity?code=test-code&state=bad-state",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("http://localhost:3100/settings?error=invalid_state")
  })

  it("redirects to settings with error when provider is not configured", async () => {
    mockDecodeState.mockReturnValueOnce({
      nonce: "test-nonce",
      provider: "unknown-provider",
      flow: "connect",
    })
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/unknown-provider?code=test-code&state=valid-state",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      "http://localhost:3100/settings?error=provider_not_configured",
    )
  })

  it("redirects to settings with error on token exchange failure", async () => {
    mockExchangeCode.mockRejectedValueOnce(new Error("Token exchange failed"))
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/auth/connect/callback/google-antigravity?code=bad-code&state=valid-state",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("http://localhost:3100/settings?error=connect_failed")
  })
})

describe("POST /auth/connect/:provider/exchange — verification failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCodePasteProvider.mockImplementation((provider: string) => {
      if (provider === "openai-codex") {
        return {
          id: "openai-codex",
          name: "OpenAI Codex",
          clientId: "test-codex-id",
          clientSecret: "test-codex-secret",
          authUrl: "https://auth.openai.com/oauth/authorize",
          tokenUrl: "https://auth.openai.com/oauth/token",
          redirectUri: "http://localhost:1455/auth/callback",
          scopes: ["openid", "profile", "email", "offline_access"],
          usePkce: true,
        }
      }
      if (provider === "google-antigravity") {
        return {
          id: "google-antigravity",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          redirectUri: "http://localhost:51121/oauth-callback",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          usePkce: true,
        }
      }
      return undefined
    })
    mockExchangeCode.mockResolvedValue({
      access_token: "codex-access-token",
      refresh_token: null,
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid profile email offline_access",
    })
  })

  it("returns ok:false with verification details when openai-codex verify fails (regression #740)", async () => {
    const { app, credentialService } = await buildTestApp()
    ;(
      credentialService.storeOAuthCredential as {
        mockResolvedValueOnce: (v: unknown) => unknown
      }
    ).mockResolvedValueOnce({
      id: "cred-codex-1",
      provider: "openai-codex",
      credentialType: "oauth",
      status: "active",
    })
    ;(
      credentialService.testCredential as { mockResolvedValueOnce: (v: unknown) => unknown }
    ).mockResolvedValueOnce({
      status: "auth_failed",
      message: "Authentication failed (HTTP 403)",
    })

    const res = await app.inject({
      method: "POST",
      url: "/auth/connect/openai-codex/exchange",
      headers: { ...withSession(), "content-type": "application/json" },
      payload: JSON.stringify({
        pastedUrl: "http://localhost:1455/auth/callback?code=test-code&state=test-state",
        codeVerifier: "test-verifier",
        state: "test-state",
      }),
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.provider).toBe("OpenAI Codex")
    const verification = body.verification as Record<string, unknown>
    expect(verification.status).toBe("auth_failed")
    expect(verification.message).toContain("403")
  })

  it("returns ok:true when openai-codex verification succeeds", async () => {
    const { app, credentialService } = await buildTestApp()
    ;(
      credentialService.storeOAuthCredential as {
        mockResolvedValueOnce: (v: unknown) => unknown
      }
    ).mockResolvedValueOnce({
      id: "cred-codex-2",
      provider: "openai-codex",
      credentialType: "oauth",
      status: "active",
    })
    ;(
      credentialService.testCredential as { mockResolvedValueOnce: (v: unknown) => unknown }
    ).mockResolvedValueOnce({
      status: "connected",
      message: "Connection successful",
    })

    const res = await app.inject({
      method: "POST",
      url: "/auth/connect/openai-codex/exchange",
      headers: { ...withSession(), "content-type": "application/json" },
      payload: JSON.stringify({
        pastedUrl: "http://localhost:1455/auth/callback?code=good-code&state=test-state",
        codeVerifier: "test-verifier",
        state: "test-state",
      }),
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.provider).toBe("OpenAI Codex")
  })
})
