/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import { AccessRequestConflictError } from "../auth/access-request-service.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentUserRoutes } from "../routes/agent-user-routes.js"
import { ensureUuid } from "../util/name-uuid.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const GRANT_ID = "gggggggg-1111-2222-3333-444444444444"
const USER_ID = "uuuuuuuu-1111-2222-3333-444444444444"
const CODE_ID = "pppppppp-1111-2222-3333-444444444444"
const REQUEST_ID = "rrrrrrrr-1111-2222-3333-444444444444"

function makeGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    agent_id: AGENT_ID,
    user_account_id: USER_ID,
    access_level: "write",
    origin: "dashboard_invite",
    granted_by: "dev-user",
    rate_limit: null,
    token_budget: null,
    expires_at: null,
    revoked_at: null,
    created_at: new Date(),
    ...overrides,
  }
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    display_name: "Test User",
    email: "test@example.com",
    avatar_url: null,
    role: "operator",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeChannelMapping(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmcmcmcm-1111-2222-3333-444444444444",
    user_account_id: USER_ID,
    channel_type: "telegram",
    channel_user_id: "12345",
    metadata: null,
    created_at: new Date(),
    ...overrides,
  }
}

function makeAccessRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    agent_id: AGENT_ID,
    channel_mapping_id: "cmcmcmcm-1111-2222-3333-444444444444",
    user_account_id: USER_ID,
    status: "pending",
    message_preview: null,
    reviewed_by: null,
    reviewed_at: null,
    deny_reason: null,
    created_at: new Date(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

interface MockDbOptions {
  grants?: Record<string, unknown>[]
  grantTotal?: number
  existingGrant?: Record<string, unknown> | null
  insertedGrant?: Record<string, unknown>
  updatedGrant?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
  channelMappings?: Record<string, unknown>[]
  joinedAgent?: { name: string } | null
}

function mockDb(opts: MockDbOptions = {}) {
  const {
    grants = [makeGrant()],
    grantTotal = grants.length,
    existingGrant = null,
    insertedGrant = makeGrant(),
    updatedGrant = makeGrant(),
    user = makeUser(),
    channelMappings = [makeChannelMapping()],
    joinedAgent = { name: "Test Agent" },
  } = opts

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_user_grant") {
        // Chain: selectAll → where → where → where → executeTakeFirst (dup check)
        // OR:   selectAll → where → where → orderBy → limit → offset → execute (list)
        // OR:   select(countAll) → executeTakeFirstOrThrow (count)
        // Use a versatile mock that supports multiple chains
        const chain = {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation((_col: string, _op: string, _val: unknown) => {
              // Return a chain that handles both list (execute) and single (executeTakeFirst)
              const innerChain: Record<string, ReturnType<typeof vi.fn>> = {}
              innerChain.where = vi.fn().mockReturnValue(innerChain)
              innerChain.orderBy = vi.fn().mockReturnValue(innerChain)
              innerChain.limit = vi.fn().mockReturnValue(innerChain)
              innerChain.offset = vi.fn().mockReturnValue(innerChain)
              innerChain.execute = vi.fn().mockResolvedValue(grants)
              innerChain.executeTakeFirst = vi.fn().mockResolvedValue(existingGrant)
              return innerChain
            }),
          }),
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              const innerChain: Record<string, ReturnType<typeof vi.fn>> = {}
              innerChain.where = vi.fn().mockReturnValue(innerChain)
              innerChain.executeTakeFirstOrThrow = vi
                .fn()
                .mockResolvedValue({ total: String(grantTotal) })
              return innerChain
            }),
          }),
          where: vi.fn().mockImplementation(() => {
            // For base query builder pattern (used in GET /agents/:agentId/users)
            const baseChain: Record<string, ReturnType<typeof vi.fn>> = {}
            baseChain.where = vi.fn().mockReturnValue(baseChain)
            baseChain.selectAll = vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue({
                    execute: vi.fn().mockResolvedValue(grants),
                  }),
                }),
              }),
            })
            baseChain.select = vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ total: String(grantTotal) }),
            })
            return baseChain
          }),
          innerJoin: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                executeTakeFirst: vi.fn().mockResolvedValue(joinedAgent),
              }),
            }),
          }),
        }
        return chain
      }

      if (table === "user_account") {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              executeTakeFirst: vi.fn().mockResolvedValue(user),
            }),
          }),
        }
      }

      if (table === "channel_mapping") {
        return {
          selectAll: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              execute: vi.fn().mockResolvedValue(channelMappings),
            }),
          }),
        }
      }

      if (table === "access_request") {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {}
        chain.where = vi.fn().mockReturnValue(chain)
        chain.selectAll = vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockReturnValue({
                execute: vi.fn().mockResolvedValue([makeAccessRequest()]),
              }),
            }),
          }),
        })
        chain.select = vi.fn().mockReturnValue({
          executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ total: "1" }),
        })
        return chain
      }

      // Fallback
      return {
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            executeTakeFirst: vi.fn().mockResolvedValue(null),
          }),
        }),
      }
    }),

    insertInto: vi.fn().mockImplementation(() => {
      return {
        values: vi.fn().mockReturnValue({
          returningAll: vi.fn().mockReturnValue({
            executeTakeFirstOrThrow: vi.fn().mockResolvedValue(insertedGrant),
          }),
        }),
      }
    }),

    updateTable: vi.fn().mockImplementation(() => {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {}
      chain.set = vi.fn().mockReturnValue(chain)
      chain.where = vi.fn().mockReturnValue(chain)
      chain.returningAll = vi.fn().mockReturnValue(chain)
      chain.executeTakeFirst = vi.fn().mockResolvedValue(updatedGrant)
      chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(updatedGrant)
      return chain
    }),
  }

  return db
}

// ---------------------------------------------------------------------------
// Mock services
// ---------------------------------------------------------------------------

function mockPairingService() {
  return {
    generate: vi.fn().mockResolvedValue({ code: "ABC123", expiresAt: new Date("2099-01-01") }),
    redeem: vi
      .fn()
      .mockResolvedValue({ success: true, message: "Pairing code redeemed", grantId: GRANT_ID }),
    listActive: vi.fn().mockResolvedValue([
      {
        id: CODE_ID,
        code: "ABC123",
        agent_id: AGENT_ID,
        created_by: "dev-user",
        expires_at: new Date("2099-01-01"),
        created_at: new Date(),
      },
    ]),
    revoke: vi.fn().mockResolvedValue(undefined),
  }
}

function mockAccessRequestService() {
  return {
    create: vi.fn().mockResolvedValue(makeAccessRequest()),
    approve: vi.fn().mockResolvedValue(makeGrant({ origin: "approval" })),
    deny: vi.fn().mockResolvedValue(undefined),
    pendingCounts: vi.fn().mockResolvedValue(new Map([[AGENT_ID, 3]])),
  }
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildTestApp(dbOpts: MockDbOptions = {}) {
  const app = Fastify({ logger: false })
  const db = mockDb(dbOpts)
  const pairing = mockPairingService()
  const accessReq = mockAccessRequestService()

  await app.register(
    agentUserRoutes({
      db: db as never,
      pairingService: pairing as never,
      accessRequestService: accessReq as never,
      authConfig: DEV_AUTH_CONFIG,
    }),
  )

  return { app, db, pairingService: pairing, accessRequestService: accessReq }
}

// ===========================================================================
// GRANTS
// ===========================================================================

describe("GET /agents/:agentId/users", () => {
  it("returns grants with total count", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/users`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.grants).toBeDefined()
    expect(Array.isArray(body.grants)).toBe(true)
    expect(typeof body.total).toBe("number")
  })
})

describe("POST /agents/:agentId/users", () => {
  it("creates a grant and returns 201", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/users`,
      payload: { user_account_id: USER_ID },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.grant).toBeDefined()
    expect(body.grant.id).toBe(GRANT_ID)
  })

  it("returns 409 when user already has a grant", async () => {
    const { app } = await buildTestApp({ existingGrant: makeGrant() })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/users`,
      payload: { user_account_id: USER_ID },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe("conflict")
  })

  it("re-activates a revoked grant instead of inserting (re-invite)", async () => {
    const revokedGrant = makeGrant({ revoked_at: new Date("2026-03-01") })
    const reactivatedGrant = makeGrant({ revoked_at: null, origin: "dashboard_invite" })
    const { app, db } = await buildTestApp({
      existingGrant: revokedGrant,
      updatedGrant: reactivatedGrant,
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/users`,
      payload: { user_account_id: USER_ID },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.grant).toBeDefined()
    expect(body.grant.revoked_at).toBeNull()
    // Should update, not insert
    expect(db.updateTable).toHaveBeenCalled()
  })

  it("validates required user_account_id", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/users`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("PATCH /agents/:agentId/users/:grantId", () => {
  it("updates a grant and returns 200", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/users/${GRANT_ID}`,
      payload: { access_level: "read" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.grant).toBeDefined()
  })

  it("returns 404 when grant not found", async () => {
    const { app } = await buildTestApp({ updatedGrant: null })

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/users/${GRANT_ID}`,
      payload: { access_level: "read" },
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 400 when no fields to update", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/users/${GRANT_ID}`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("DELETE /agents/:agentId/users/:grantId", () => {
  it("revokes a grant and returns 204", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/users/${GRANT_ID}`,
    })

    expect(res.statusCode).toBe(204)
  })

  it("returns 404 when grant not found", async () => {
    const { app } = await buildTestApp({ updatedGrant: null })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/users/${GRANT_ID}`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ===========================================================================
// PAIRING CODES
// ===========================================================================

describe("POST /agents/:agentId/pairing-codes", () => {
  it("generates a pairing code and returns 201", async () => {
    const { app, pairingService: pairing } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/pairing-codes`,
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.code).toBe("ABC123")
    expect(body.expiresAt).toBeDefined()
    expect(pairing.generate).toHaveBeenCalledWith(AGENT_ID, ensureUuid("dev-user"))
  })
})

describe("GET /agents/:agentId/pairing-codes", () => {
  it("returns active pairing codes", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/pairing-codes`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.codes).toBeDefined()
    expect(Array.isArray(body.codes)).toBe(true)
  })
})

describe("DELETE /agents/:agentId/pairing-codes/:codeId", () => {
  it("revokes a pairing code and returns 204", async () => {
    const { app, pairingService: pairing } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/pairing-codes/${CODE_ID}`,
    })

    expect(res.statusCode).toBe(204)
    expect(pairing.revoke).toHaveBeenCalledWith(CODE_ID)
  })
})

// ===========================================================================
// ACCESS REQUESTS
// ===========================================================================

describe("GET /agents/:agentId/access-requests", () => {
  it("returns access requests with total", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/access-requests?status=pending`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.requests).toBeDefined()
    expect(typeof body.total).toBe("number")
  })
})

describe("PATCH /agents/:agentId/access-requests/:requestId", () => {
  it("approves a request and creates a grant", async () => {
    const { app, accessRequestService: arService } = await buildTestApp()

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/access-requests/${REQUEST_ID}`,
      payload: { status: "approved" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.request.status).toBe("approved")
    expect(body.request.grant_id).toBe(GRANT_ID)
    expect(arService.approve).toHaveBeenCalledWith(REQUEST_ID, ensureUuid("dev-user"))
  })

  it("denies a request", async () => {
    const { app, accessRequestService: arService } = await buildTestApp()

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/access-requests/${REQUEST_ID}`,
      payload: { status: "denied", deny_reason: "Not authorized" },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.request.status).toBe("denied")
    expect(arService.deny).toHaveBeenCalledWith(
      REQUEST_ID,
      ensureUuid("dev-user"),
      "Not authorized",
    )
  })

  it("returns 409 on conflict", async () => {
    const { app, accessRequestService: arService } = await buildTestApp()
    arService.approve.mockRejectedValueOnce(new AccessRequestConflictError("Already approved"))

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/access-requests/${REQUEST_ID}`,
      payload: { status: "approved" },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe("conflict")
  })

  it("validates required status field", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PATCH",
      url: `/agents/${AGENT_ID}/access-requests/${REQUEST_ID}`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

describe("GET /access-requests/pending-count", () => {
  it("returns per-agent pending counts", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/access-requests/pending-count",
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.counts).toBeDefined()
    expect(body.counts[AGENT_ID]).toBe(3)
  })
})

// ===========================================================================
// USER PROFILE
// ===========================================================================

describe("GET /users/:userId", () => {
  it("returns user with channel mappings and grants", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/users/${USER_ID}`,
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.user).toBeDefined()
    expect(body.user.id).toBe(USER_ID)
    expect(Array.isArray(body.channelMappings)).toBe(true)
    expect(Array.isArray(body.grants)).toBe(true)
  })

  it("returns 404 when user not found", async () => {
    const { app } = await buildTestApp({ user: null })

    const res = await app.inject({
      method: "GET",
      url: `/users/${USER_ID}`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ===========================================================================
// PAIRING
// ===========================================================================

describe("POST /pair", () => {
  it("redeems a pairing code and returns linked=true", async () => {
    const { app, pairingService: pairing } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: {
        code: "ABC123",
        channel_mapping_id: "cmcmcmcm-1111-2222-3333-444444444444",
        user_account_id: USER_ID,
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.linked).toBe(true)
    expect(body.agentName).toBe("Test Agent")
    expect(pairing.redeem).toHaveBeenCalledWith(
      "ABC123",
      "cmcmcmcm-1111-2222-3333-444444444444",
      USER_ID,
    )
  })

  it("returns 400 when pairing code is invalid", async () => {
    const { app, pairingService: pairing } = await buildTestApp()
    pairing.redeem.mockResolvedValueOnce({
      success: false,
      message: "Invalid pairing code",
    })

    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: {
        code: "BADCODE",
        channel_mapping_id: "cmcmcmcm-1111-2222-3333-444444444444",
        user_account_id: USER_ID,
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe("bad_request")
    expect(body.message).toContain("Invalid")
  })

  it("validates required fields", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})
