/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import Fastify from "fastify"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { CredentialSummary } from "../auth/credential-service.js"
import type { AuthOAuthConfig } from "../config.js"
import { modelDiscoveryService } from "../observability/model-providers.js"
import { credentialRoutes } from "../routes/credentials.js"

// Seed discovery cache so modelsForProvider returns data in tests
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = (modelDiscoveryService as any).cache as Map<string, unknown>
  cache.set("anthropic", {
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["anthropic"] },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providers: ["anthropic"] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providers: ["anthropic"] },
    ],
    expiresAt: Date.now() + 60 * 60 * 1000,
  })
  cache.set("openai", {
    models: [
      { id: "gpt-4o", label: "GPT-4o", providers: ["openai"] },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai"] },
    ],
    expiresAt: Date.now() + 60 * 60 * 1000,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRED_ID = "cccccccc-1111-2222-3333-444444444444"

function makeSummary(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: CRED_ID,
    provider: "brave",
    credentialType: "api_key",
    credentialClass: "tool_specific",
    toolName: "brave-search",
    displayLabel: "Brave Search Production",
    status: "active",
    accountId: null,
    scopes: null,
    tokenExpiresAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    maskedKey: "****5678",
    errorCount: 0,
    lastError: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  }
}

function mockCredentialService(overrides: Record<string, unknown> = {}) {
  return {
    storeToolSecret: vi.fn().mockResolvedValue(makeSummary()),
    rotateToolSecret: vi.fn().mockResolvedValue(makeSummary()),
    listToolSecrets: vi.fn().mockResolvedValue([makeSummary()]),
    listCredentials: vi.fn().mockResolvedValue([]),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
    getAuditLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

/**
 * Fake SessionService whose validateSession returns a principal
 * with the specified role. This lets us test admin vs non-admin access.
 */
function mockSessionService(role: "admin" | "viewer" = "admin") {
  const ROLE_MAP: Record<string, string[]> = {
    admin: ["operator", "approver", "admin"],
    viewer: ["viewer"],
  }

  return {
    validateSession: vi.fn().mockResolvedValue({
      session: { id: "sess-1", csrfToken: "tok" },
      user: {
        userId: "user-1",
        role,
        roles: ROLE_MAP[role],
        displayName: "Test User",
        email: "test@example.com",
      },
    }),
    validateCsrf: vi.fn().mockReturnValue(true),
  }
}

/** Auth config with all OAuth providers configured. */
const FULL_AUTH_CONFIG: AuthOAuthConfig = {
  dashboardUrl: "http://localhost:3100",
  credentialMasterKey: "test-master-key",
  sessionMaxAge: 3600,
  googleAntigravity: { clientId: "ga-id", clientSecret: "ga-secret" },
  openaiCodex: { clientId: "oc-id", clientSecret: "oc-secret" },
  anthropic: { clientId: "ant-id", clientSecret: "ant-secret" },
  googleWorkspace: { clientId: "gw-id", clientSecret: "gw-secret" },
  githubUser: { clientId: "gh-id", clientSecret: "gh-secret" },
  slackUser: { clientId: "sl-id", clientSecret: "sl-secret" },
}

async function buildTestApp(
  opts: {
    credentialServiceOverrides?: Record<string, unknown>
    role?: "admin" | "viewer"
    authConfig?: AuthOAuthConfig
  } = {},
) {
  const app = Fastify({ logger: false })
  const credentialService = mockCredentialService(opts.credentialServiceOverrides)
  const sessionService = mockSessionService(opts.role ?? "admin")

  await app.register(
    credentialRoutes({
      credentialService: credentialService as never,
      sessionService: sessionService as never,
      authConfig: opts.authConfig ?? FULL_AUTH_CONFIG,
    }),
  )

  return { app, credentialService, sessionService }
}

function withSession(headers: Record<string, string> = {}) {
  return { cookie: "cortex_session=sess-1", ...headers }
}

// ---------------------------------------------------------------------------
// Tests: GET /credentials/providers
// ---------------------------------------------------------------------------

describe("GET /credentials/providers", () => {
  it("returns providers with models for LLM providers", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/credentials/providers",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.providers).toBeDefined()

    // Anthropic should include Claude models
    const anthropic = body.providers.find((p: { id: string }) => p.id === "anthropic")
    expect(anthropic).toBeDefined()
    expect(anthropic.models).toBeDefined()
    expect(anthropic.models.length).toBeGreaterThan(0)
    expect(anthropic.models.some((m: { id: string }) => m.id === "claude-sonnet-4-6")).toBe(true)

    // OpenAI should include GPT models
    const openai = body.providers.find((p: { id: string }) => p.id === "openai")
    expect(openai).toBeDefined()
    expect(openai.models).toBeDefined()
    expect(openai.models.some((m: { id: string }) => m.id === "gpt-4o")).toBe(true)

    // user_service providers should not have models
    const googleWorkspace = body.providers.find((p: { id: string }) => p.id === "google-workspace")
    expect(googleWorkspace).toBeDefined()
    expect(googleWorkspace.models).toBeUndefined()
  })

  it("returns empty list when no authConfig is provided", async () => {
    const app = Fastify({ logger: false })
    await app.register(
      credentialRoutes({
        credentialService: mockCredentialService() as never,
        sessionService: mockSessionService() as never,
      }),
    )

    const res = await app.inject({
      method: "GET",
      url: "/credentials/providers",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.providers).toEqual([])
  })

  it("only returns configured OAuth providers", async () => {
    const partialAuth: AuthOAuthConfig = {
      dashboardUrl: "http://localhost:3100",
      credentialMasterKey: "test-master-key",
      sessionMaxAge: 3600,
      googleAntigravity: { clientId: "ga-id", clientSecret: "ga-secret" },
      // No other OAuth providers configured
    }
    const { app } = await buildTestApp({ authConfig: partialAuth })

    const res = await app.inject({
      method: "GET",
      url: "/credentials/providers",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids = body.providers.map((p: { id: string }) => p.id) as string[]

    // google-antigravity is configured → included
    expect(ids).toContain("google-antigravity")

    // API key providers always included
    expect(ids).toContain("openai")
    expect(ids).toContain("google-ai-studio")
    expect(ids).toContain("brave")

    // Unconfigured OAuth providers excluded
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai-codex")
    expect(ids).not.toContain("google-workspace")
    expect(ids).not.toContain("github-user")
    expect(ids).not.toContain("slack-user")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /credentials/tool-secret
// ---------------------------------------------------------------------------

describe("POST /credentials/tool-secret", () => {
  it("creates a tool secret (admin)", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "brave-search",
        provider: "brave",
        apiKey: "BSA_test1234",
        displayLabel: "Brave Search Production",
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.credential).toBeDefined()
    expect(body.credential.id).toBe(CRED_ID)

    expect(credentialService.storeToolSecret).toHaveBeenCalledWith(
      "user-1",
      "brave-search",
      "brave",
      "BSA_test1234",
      { displayLabel: "Brave Search Production" },
    )
  })

  it("returns 403 for non-admin users", async () => {
    const { app } = await buildTestApp({ role: "viewer" })

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "brave-search",
        provider: "brave",
        apiKey: "BSA_test1234",
      },
    })

    expect(res.statusCode).toBe(403)
  })

  it("returns 401 without auth", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      payload: {
        toolName: "brave-search",
        provider: "brave",
        apiKey: "BSA_test1234",
      },
    })

    expect(res.statusCode).toBe(401)
  })

  it("rejects invalid toolName (uppercase)", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "Brave-Search",
        provider: "brave",
        apiKey: "BSA_test1234",
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("toolName")
  })

  it("rejects toolName starting with hyphen", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "-bad-name",
        provider: "brave",
        apiKey: "BSA_test1234",
      },
    })

    expect(res.statusCode).toBe(400)
  })

  it("rejects empty provider", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "brave-search",
        provider: "",
        apiKey: "BSA_test1234",
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("provider")
  })

  it("rejects short apiKey", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/credentials/tool-secret",
      headers: withSession(),
      payload: {
        toolName: "brave-search",
        provider: "brave",
        apiKey: "short",
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("8 characters")
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /credentials/:id/rotate
// ---------------------------------------------------------------------------

describe("PUT /credentials/:id/rotate", () => {
  it("rotates a tool secret (admin)", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "BSA_new_key_1234" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.credential).toBeDefined()

    expect(credentialService.rotateToolSecret).toHaveBeenCalledWith(
      "user-1",
      CRED_ID,
      "BSA_new_key_1234",
    )
  })

  it("returns 404 when credential not found", async () => {
    const { app } = await buildTestApp({
      credentialServiceOverrides: {
        rotateToolSecret: vi.fn().mockResolvedValue(null),
      },
    })

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "BSA_new_key_1234" },
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.message).toContain("not found")
  })

  it("returns 401 without auth", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      payload: { apiKey: "BSA_new_key_1234" },
    })

    expect(res.statusCode).toBe(401)
  })

  it("returns 403 for non-admin users", async () => {
    const { app } = await buildTestApp({ role: "viewer" })

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "BSA_new_key_1234" },
    })

    expect(res.statusCode).toBe(403)
  })

  it("rejects short apiKey", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "short" },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("8 characters")
  })

  it("rejects invalid toolName", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "BSA_new_key_1234", toolName: "INVALID!!!" },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.message).toContain("toolName")
  })

  it("accepts valid toolName", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/credentials/${CRED_ID}/rotate`,
      headers: withSession(),
      payload: { apiKey: "BSA_new_key_1234", toolName: "my-tool-1" },
    })

    expect(res.statusCode).toBe(200)
    expect(credentialService.rotateToolSecret).toHaveBeenCalledWith(
      "user-1",
      CRED_ID,
      "BSA_new_key_1234",
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /credentials?class=tool_specific
// ---------------------------------------------------------------------------

describe("GET /credentials?class=tool_specific", () => {
  it("lists tool secrets for admin", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/credentials?class=tool_specific",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0].credentialClass).toBe("tool_specific")

    expect(credentialService.listToolSecrets).toHaveBeenCalledWith("user-1")
  })

  it("returns 403 for non-admin", async () => {
    const { app } = await buildTestApp({ role: "viewer" })

    const res = await app.inject({
      method: "GET",
      url: "/credentials?class=tool_specific",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(403)
  })

  it("lists user credentials without class filter", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/credentials",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    expect(credentialService.listCredentials).toHaveBeenCalledWith("user-1")
    expect(credentialService.listToolSecrets).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /credentials — health fields
// ---------------------------------------------------------------------------

describe("GET /credentials — credential health fields", () => {
  it("returns health fields for an active credential", async () => {
    const healthyCred = makeSummary({
      provider: "openai",
      credentialType: "api_key",
      credentialClass: "llm_provider",
      status: "active",
      errorCount: 0,
      lastError: null,
      lastUsedAt: "2026-03-09T10:00:00.000Z",
      tokenExpiresAt: null,
      lastRefreshAt: null,
    })

    const { app } = await buildTestApp({
      credentialServiceOverrides: {
        listCredentials: vi.fn().mockResolvedValue([healthyCred]),
      },
    })

    const res = await app.inject({
      method: "GET",
      url: "/credentials",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.credentials).toHaveLength(1)
    const cred = body.credentials[0]
    expect(cred.status).toBe("active")
    expect(cred.errorCount).toBe(0)
    expect(cred.lastError).toBeNull()
    expect(cred.lastUsedAt).toBe("2026-03-09T10:00:00.000Z")
  })

  it("returns health fields for an errored credential", async () => {
    const erroredCred = makeSummary({
      provider: "anthropic",
      credentialType: "oauth",
      credentialClass: "llm_provider",
      status: "error",
      errorCount: 3,
      lastError: "token refresh failed: invalid_grant",
      lastUsedAt: "2026-03-08T14:00:00.000Z",
      tokenExpiresAt: "2026-03-08T12:00:00.000Z",
      lastRefreshAt: "2026-03-08T11:30:00.000Z",
    })

    const { app } = await buildTestApp({
      credentialServiceOverrides: {
        listCredentials: vi.fn().mockResolvedValue([erroredCred]),
      },
    })

    const res = await app.inject({
      method: "GET",
      url: "/credentials",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.credentials).toHaveLength(1)
    const cred = body.credentials[0]
    expect(cred.status).toBe("error")
    expect(cred.errorCount).toBe(3)
    expect(cred.lastError).toBe("token refresh failed: invalid_grant")
    expect(cred.tokenExpiresAt).toBe("2026-03-08T12:00:00.000Z")
    expect(cred.lastRefreshAt).toBe("2026-03-08T11:30:00.000Z")
  })

  it("returns health fields for an OAuth credential with upcoming expiry", async () => {
    const oauthCred = makeSummary({
      provider: "google-antigravity",
      credentialType: "oauth",
      credentialClass: "llm_provider",
      status: "active",
      errorCount: 0,
      lastError: null,
      tokenExpiresAt: "2026-03-10T12:00:00.000Z",
      lastRefreshAt: "2026-03-09T11:00:00.000Z",
    })

    const { app } = await buildTestApp({
      credentialServiceOverrides: {
        listCredentials: vi.fn().mockResolvedValue([oauthCred]),
      },
    })

    const res = await app.inject({
      method: "GET",
      url: "/credentials",
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    const cred = body.credentials[0]
    expect(cred.tokenExpiresAt).toBe("2026-03-10T12:00:00.000Z")
    expect(cred.lastRefreshAt).toBe("2026-03-09T11:00:00.000Z")
    expect(cred.errorCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /credentials/:id
// ---------------------------------------------------------------------------

describe("DELETE /credentials/:id", () => {
  it("deletes a credential and returns ok", async () => {
    const { app, credentialService } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/credentials/${CRED_ID}`,
      headers: withSession(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({ ok: true })
    expect(credentialService.deleteCredential).toHaveBeenCalledWith("user-1", CRED_ID)
  })

  it("returns 401 without auth", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/credentials/${CRED_ID}`,
    })

    expect(res.statusCode).toBe(401)
  })
})
