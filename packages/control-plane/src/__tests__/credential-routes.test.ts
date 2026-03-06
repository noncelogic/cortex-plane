/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import type { CredentialSummary } from "../auth/credential-service.js"
import { credentialRoutes } from "../routes/credentials.js"

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

async function buildTestApp(
  opts: {
    credentialServiceOverrides?: Record<string, unknown>
    role?: "admin" | "viewer"
  } = {},
) {
  const app = Fastify({ logger: false })
  const credentialService = mockCredentialService(opts.credentialServiceOverrides)
  const sessionService = mockSessionService(opts.role ?? "admin")

  await app.register(
    credentialRoutes({
      credentialService: credentialService as never,
      sessionService: sessionService as never,
    }),
  )

  return { app, credentialService, sessionService }
}

function withSession(headers: Record<string, string> = {}) {
  return { cookie: "cortex_session=sess-1", ...headers }
}

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
