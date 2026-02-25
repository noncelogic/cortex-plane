import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"

import { createRequireAuth, createRequireRole } from "../middleware/auth.js"
import { hashApiKey, loadAuthConfig, findApiKey } from "../middleware/api-keys.js"
import type { ApiKeyRecord, AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// hashApiKey
// ---------------------------------------------------------------------------

describe("hashApiKey", () => {
  it("produces a 64-character hex SHA-256 hash", () => {
    const hash = hashApiKey("test-key-123")
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic", () => {
    expect(hashApiKey("my-key")).toBe(hashApiKey("my-key"))
  })

  it("different keys produce different hashes", () => {
    expect(hashApiKey("key-a")).not.toBe(hashApiKey("key-b"))
  })
})

// ---------------------------------------------------------------------------
// loadAuthConfig
// ---------------------------------------------------------------------------

describe("loadAuthConfig", () => {
  it("returns empty config when no env vars set", () => {
    const config = loadAuthConfig({})
    expect(config.apiKeys).toEqual([])
    expect(config.requireAuth).toBe(false)
  })

  it("parses CORTEX_API_KEYS from JSON", () => {
    const keys = [
      { key: "sk-test-1", userId: "user-1", roles: ["operator"], label: "Test Key 1" },
      { key: "sk-test-2", userId: "user-2", roles: ["approver"], label: "Test Key 2" },
    ]
    const config = loadAuthConfig({
      CORTEX_API_KEYS: JSON.stringify(keys),
    })

    expect(config.apiKeys).toHaveLength(2)
    expect(config.apiKeys[0]!.userId).toBe("user-1")
    expect(config.apiKeys[0]!.roles).toEqual(["operator"])
    // Plaintext key should be hashed
    expect(config.apiKeys[0]!.keyHash).toBe(hashApiKey("sk-test-1"))
  })

  it("requires auth when keys are configured", () => {
    const keys = [{ key: "sk-test", userId: "u", roles: ["operator"], label: "k" }]
    const config = loadAuthConfig({
      CORTEX_API_KEYS: JSON.stringify(keys),
    })
    expect(config.requireAuth).toBe(true)
  })

  it("does not require auth when CORTEX_REQUIRE_AUTH=false", () => {
    const keys = [{ key: "sk-test", userId: "u", roles: ["operator"], label: "k" }]
    const config = loadAuthConfig({
      CORTEX_API_KEYS: JSON.stringify(keys),
      CORTEX_REQUIRE_AUTH: "false",
    })
    expect(config.requireAuth).toBe(false)
  })

  it("skips malformed key entries", () => {
    const keys = [
      { key: "sk-good", userId: "u", roles: ["operator"], label: "good" },
      { key: "", userId: "u", roles: ["operator"], label: "empty key" },
      { key: "sk-no-roles", userId: "u", roles: "not-array", label: "bad" },
    ]
    const config = loadAuthConfig({
      CORTEX_API_KEYS: JSON.stringify(keys),
    })
    expect(config.apiKeys).toHaveLength(1)
    expect(config.apiKeys[0]!.label).toBe("good")
  })

  it("handles invalid JSON gracefully", () => {
    const config = loadAuthConfig({
      CORTEX_API_KEYS: "not-json",
    })
    expect(config.apiKeys).toEqual([])
    expect(config.requireAuth).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// findApiKey
// ---------------------------------------------------------------------------

describe("findApiKey", () => {
  const records: ApiKeyRecord[] = [
    { keyHash: hashApiKey("sk-alpha"), userId: "user-a", roles: ["operator"], label: "Alpha" },
    { keyHash: hashApiKey("sk-beta"), userId: "user-b", roles: ["approver"], label: "Beta" },
  ]

  it("finds a matching key", () => {
    const result = findApiKey("sk-alpha", records)
    expect(result).toBeDefined()
    expect(result!.userId).toBe("user-a")
  })

  it("returns undefined for unknown key", () => {
    expect(findApiKey("sk-unknown", records)).toBeUndefined()
  })

  it("returns correct record for second key", () => {
    const result = findApiKey("sk-beta", records)
    expect(result).toBeDefined()
    expect(result!.userId).toBe("user-b")
  })
})

// ---------------------------------------------------------------------------
// requireAuth middleware (Fastify integration)
// ---------------------------------------------------------------------------

describe("requireAuth middleware", () => {
  const TEST_KEY = "sk-test-key-12345"
  const authConfig: AuthConfig = {
    apiKeys: [
      {
        keyHash: hashApiKey(TEST_KEY),
        userId: "user-1",
        roles: ["operator", "approver"],
        label: "Test Key",
      },
    ],
    requireAuth: true,
  }

  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
    const requireAuth = createRequireAuth(authConfig)

    app.get(
      "/protected",
      { preHandler: [requireAuth] },
      async (request) => {
        const principal = (request as AuthenticatedRequest).principal
        return { userId: principal.userId, roles: principal.roles }
      },
    )

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("returns 401 when no credentials provided", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe("unauthorized")
  })

  it("returns 401 for invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer invalid-key" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("returns 401 for invalid X-API-Key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": "invalid-key" },
    })
    expect(res.statusCode).toBe(401)
  })

  it("returns 200 with valid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${TEST_KEY}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe("user-1")
    expect(res.json().roles).toEqual(["operator", "approver"])
  })

  it("returns 200 with valid X-API-Key header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-api-key": TEST_KEY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe("user-1")
  })

  it("prefers Authorization header over X-API-Key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${TEST_KEY}`,
        "x-api-key": "wrong-key",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe("user-1")
  })
})

// ---------------------------------------------------------------------------
// requireAuth dev mode (no auth configured)
// ---------------------------------------------------------------------------

describe("requireAuth dev mode", () => {
  const devConfig: AuthConfig = {
    apiKeys: [],
    requireAuth: false,
  }

  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
    const requireAuth = createRequireAuth(devConfig)

    app.get(
      "/protected",
      { preHandler: [requireAuth] },
      async (request) => {
        const principal = (request as AuthenticatedRequest).principal
        return { userId: principal.userId }
      },
    )

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("allows requests without credentials in dev mode", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe("dev-user")
  })

  it("allows requests with invalid credentials in dev mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer bad-key" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().userId).toBe("dev-user")
  })
})

// ---------------------------------------------------------------------------
// requireRole middleware
// ---------------------------------------------------------------------------

describe("requireRole middleware", () => {
  const TEST_KEY_OPERATOR = "sk-operator-key"
  const TEST_KEY_VIEWER = "sk-viewer-key"

  const authConfig: AuthConfig = {
    apiKeys: [
      {
        keyHash: hashApiKey(TEST_KEY_OPERATOR),
        userId: "user-op",
        roles: ["operator"],
        label: "Operator",
      },
      {
        keyHash: hashApiKey(TEST_KEY_VIEWER),
        userId: "user-view",
        roles: ["viewer"],
        label: "Viewer",
      },
    ],
    requireAuth: true,
  }

  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
    const requireAuth = createRequireAuth(authConfig)
    const requireOperator = createRequireRole("operator")

    app.post(
      "/admin-only",
      { preHandler: [requireAuth, requireOperator] },
      async () => ({ ok: true }),
    )

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("returns 403 when user lacks required role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${TEST_KEY_VIEWER}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe("forbidden")
    expect(res.json().message).toContain("operator")
  })

  it("returns 200 when user has required role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${TEST_KEY_OPERATOR}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it("returns 401 when no auth at all (before role check)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
    })
    expect(res.statusCode).toBe(401)
  })
})
