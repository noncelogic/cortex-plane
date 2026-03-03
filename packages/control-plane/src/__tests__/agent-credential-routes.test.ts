import Fastify from "fastify"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentCredentialRoutes } from "../routes/agent-credentials.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const CRED_ID = "cccccccc-1111-2222-3333-444444444444"
const USER_ID = "dev-user"
const BINDING_ID = "bbbbbbbb-1111-2222-3333-444444444444"

function makeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: CRED_ID,
    user_account_id: USER_ID,
    credential_class: "llm_provider",
    provider: "anthropic",
    display_label: "Anthropic (direct)",
    status: "active",
    ...overrides,
  }
}

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: BINDING_ID,
    agent_id: AGENT_ID,
    provider_credential_id: CRED_ID,
    scope: null,
    created_at: new Date(),
    ...overrides,
  }
}

function makeJoinedBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: BINDING_ID,
    credentialId: CRED_ID,
    credentialClass: "llm_provider",
    provider: "anthropic",
    displayLabel: "Anthropic (direct)",
    status: "active",
    grantedAt: new Date(),
    ...overrides,
  }
}

/**
 * Build a mock Kysely database that supports the query patterns used by
 * agentCredentialRoutes. Each table handler returns chainable methods.
 */
function mockDb(
  opts: {
    agentExists?: boolean
    credential?: Record<string, unknown> | null
    existingBinding?: Record<string, unknown> | null
    insertedBinding?: Record<string, unknown>
    joinedBindings?: Record<string, unknown>[]
  } = {},
) {
  const {
    agentExists = true,
    credential = makeCredential(),
    existingBinding = null,
    insertedBinding = makeBinding(),
    joinedBindings = [makeJoinedBinding()],
  } = opts

  // Track insertInto calls for audit log verification
  const auditInsertValues = vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue([]),
  })

  // Track deleteFrom calls
  const deleteExecute = vi.fn().mockResolvedValue([])
  const deleteWhere2 = vi.fn().mockReturnValue({ execute: deleteExecute })
  const deleteWhere1 = vi.fn().mockReturnValue({ where: deleteWhere2 })

  // selectFrom dispatch — the route uses multiple tables
  let selectCallCount = 0

  function agentSelectChain() {
    const row = agentExists ? { id: AGENT_ID } : null
    const executeTakeFirst = vi.fn().mockResolvedValue(row)
    const where = vi.fn().mockReturnValue({ executeTakeFirst })
    const select = vi.fn().mockReturnValue({ where })
    return { select }
  }

  function credentialSelectChain() {
    const executeTakeFirst = vi.fn().mockResolvedValue(credential)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    return { select }
  }

  function bindingSelectChain() {
    const executeTakeFirst = vi.fn().mockResolvedValue(existingBinding)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
    const select = vi.fn().mockReturnValue({ where: whereFn })
    return { select }
  }

  function bindingJoinSelectChain() {
    const execute = vi.fn().mockResolvedValue(joinedBindings)
    const orderBy = vi.fn().mockReturnValue({ execute })
    const where = vi.fn().mockReturnValue({ orderBy })
    const select = vi.fn().mockReturnValue({ where })
    const innerJoin = vi.fn().mockReturnValue({ select })
    return { innerJoin }
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "agent") return agentSelectChain()

      if (table === "provider_credential") {
        // POST uses this for credential lookup, DELETE uses for audit metadata
        return credentialSelectChain()
      }

      if (table === "agent_credential_binding") {
        selectCallCount++
        // First call in POST: duplicate check. In GET: join query. In DELETE: binding lookup.
        if (selectCallCount === 1 && existingBinding !== undefined) {
          // Could be POST duplicate check or GET join or DELETE lookup
          // We handle via the opts pattern
        }
        // For GET route, return the join chain
        return { ...bindingSelectChain(), ...bindingJoinSelectChain() }
      }

      return agentSelectChain()
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_credential_binding") {
        const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(insertedBinding)
        const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
        const values = vi.fn().mockReturnValue({ returningAll })
        return { values }
      }

      if (table === "credential_audit_log") {
        return { values: auditInsertValues }
      }

      return {
        values: vi.fn().mockReturnValue({
          returningAll: vi.fn().mockReturnValue({
            executeTakeFirstOrThrow: vi.fn().mockResolvedValue({}),
          }),
          execute: vi.fn().mockResolvedValue([]),
        }),
      }
    }),

    deleteFrom: vi.fn().mockReturnValue({ where: deleteWhere1 }),
  } as unknown as Kysely<Database>

  return { db, auditInsertValues, deleteExecute }
}

async function buildTestApp(dbOpts: Parameters<typeof mockDb>[0] = {}) {
  const app = Fastify({ logger: false })
  const { db, auditInsertValues, deleteExecute } = mockDb(dbOpts)

  await app.register(agentCredentialRoutes({ db, authConfig: DEV_AUTH_CONFIG }))

  return { app, db, auditInsertValues, deleteExecute }
}

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/credentials
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/credentials", () => {
  it("binds a credential to an agent", async () => {
    const { app, auditInsertValues } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding.agentId).toBe(AGENT_ID)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding.credentialId).toBe(CRED_ID)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.binding.credentialClass).toBe("llm_provider")

    // Verify audit log was written
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Agent")
  })

  it("returns 404 when credential does not exist", async () => {
    const { app } = await buildTestApp({ credential: null })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Credential")
  })

  it("returns 400 when credential is not active", async () => {
    const { app } = await buildTestApp({
      credential: makeCredential({ status: "expired" }),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(400)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("not active")
  })

  it("returns 403 when user does not own the credential", async () => {
    const { app } = await buildTestApp({
      credential: makeCredential({ user_account_id: "other-user-id" }),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(403)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("own credentials")
  })

  it("allows admin to bind tool_secret credential", async () => {
    const { app } = await buildTestApp({
      credential: makeCredential({
        credential_class: "tool_specific",
        user_account_id: "admin-user-id",
      }),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    // Dev mode principal has admin role, so this should succeed
    expect(res.statusCode).toBe(201)
  })

  it("returns 409 on duplicate binding", async () => {
    const { app } = await buildTestApp({
      existingBinding: makeBinding(),
    })

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: { credentialId: CRED_ID },
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("already bound")
  })

  it("validates required credentialId field", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/agents/${AGENT_ID}/credentials`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/credentials
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/credentials", () => {
  it("returns list of bindings with credential metadata", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/credentials`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bindings).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(Array.isArray(body.bindings)).toBe(true)
  })

  it("returns 404 when agent does not exist", async () => {
    const { app } = await buildTestApp({ agentExists: false })

    const res = await app.inject({
      method: "GET",
      url: `/agents/${AGENT_ID}/credentials`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:agentId/credentials/:credentialId
// ---------------------------------------------------------------------------

describe("DELETE /agents/:agentId/credentials/:credentialId", () => {
  it("unbinds a credential from an agent", async () => {
    const { app, auditInsertValues } = await buildTestApp({
      existingBinding: makeBinding(),
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/credentials/${CRED_ID}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    // Verify audit log was written
    expect(auditInsertValues).toHaveBeenCalled()
  })

  it("returns 404 when binding does not exist", async () => {
    const { app } = await buildTestApp({
      existingBinding: null,
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/agents/${AGENT_ID}/credentials/${CRED_ID}`,
    })

    expect(res.statusCode).toBe(404)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(res.json().message).toContain("Binding")
  })
})
