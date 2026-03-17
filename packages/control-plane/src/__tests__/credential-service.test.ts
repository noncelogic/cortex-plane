// Set env vars before imports so CODE_PASTE_PROVIDERS is populated.
vi.hoisted(() => {
  process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_ID = "test-ga-id"
  process.env.OAUTH_OPENAI_CODEX_CLIENT_ID = "test-oc-id"
  // Anthropic: CLIENT_ID only, no CLIENT_SECRET (PKCE-only)
  process.env.OAUTH_ANTHROPIC_CLIENT_ID = "test-ant-id"
})

import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import {
  deriveMasterKey,
  encryptCredential,
  encryptUserKey,
  generateUserKey,
} from "../auth/credential-encryption.js"
import {
  CredentialService,
  getConfiguredProviders,
  SUPPORTED_PROVIDERS,
} from "../auth/credential-service.js"
import type { AuthOAuthConfig } from "../config.js"
import type { Database, ProviderCredential } from "../db/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_PASSPHRASE = "test-master-key"
const MASTER_KEY = deriveMasterKey(MASTER_PASSPHRASE)
const USER_KEY = generateUserKey()
const ENCRYPTED_USER_KEY = encryptUserKey(USER_KEY, MASTER_KEY)

const ADMIN_USER_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const OPERATOR_USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const CRED_ID = "cccccccc-1111-2222-3333-444444444444"

const now = new Date()

function makeCredRow(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: CRED_ID,
    user_account_id: ADMIN_USER_ID,
    provider: "brave",
    credential_type: "api_key",
    credential_class: "llm_provider",
    access_token_enc: null,
    refresh_token_enc: null,
    api_key_enc: encryptCredential("sk-test-api-key-12345678", USER_KEY),
    token_expires_at: null,
    scopes: null,
    account_id: null,
    display_label: "brave",
    status: "active",
    last_used_at: null,
    last_refresh_at: null,
    error_count: 0,
    last_error: null,
    tool_name: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

const AUTH_CONFIG = {
  credentialMasterKey: MASTER_PASSPHRASE,
} as Parameters<typeof CredentialService.prototype.constructor>[1]

/**
 * Build a chainable Kysely mock.
 *
 * The mock tracks calls by table name and call order so different
 * parts of the service get the responses they need.
 */
function buildMockDb(opts: {
  userRole?: string
  userKeyExists?: boolean
  existingCred?: ProviderCredential | null
  insertedCred?: ProviderCredential
  updatedCred?: ProviderCredential
  listCreds?: ProviderCredential[]
  toolSecretCred?: ProviderCredential | null
}) {
  const {
    userRole = "admin",
    userKeyExists = true,
    existingCred = null,
    insertedCred,
    updatedCred,
    listCreds,
    toolSecretCred,
  } = opts

  const auditValues = vi.fn()

  // Track selectFrom calls by table
  const selectFromCalls: string[] = []

  function makeTerminal(result: unknown) {
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
    const executeTakeFirst = vi.fn().mockResolvedValue(result)
    const execute = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result])
    return { executeTakeFirstOrThrow, executeTakeFirst, execute }
  }

  function makeChainable(result: unknown) {
    const terminal = makeTerminal(result)
    const orderBy: ReturnType<typeof vi.fn> = vi.fn()
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    const chain = { where: whereFn, orderBy, ...terminal }
    orderBy.mockReturnValue(chain)
    whereFn.mockReturnValue(chain)
    const selectAll = vi.fn().mockReturnValue(chain)
    const select = vi.fn().mockReturnValue(chain)
    return { selectAll, select, where: whereFn, ...terminal }
  }

  function makeWhereChain(result: unknown) {
    const terminal = makeTerminal(result)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    const chain = { where: whereFn, ...terminal }
    whereFn.mockReturnValue(chain)
    return chain
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      selectFromCalls.push(table)

      if (table === "user_account") {
        // Differentiate between role check and encryption key check
        const roleResult = { role: userRole }
        const keyResult = { encryption_key_enc: userKeyExists ? ENCRYPTED_USER_KEY : null }

        // The select("role") vs select("encryption_key_enc") distinguishes the calls
        const selectFn = vi.fn().mockImplementation((col: string) => {
          const result = col === "role" ? roleResult : keyResult
          return makeWhereChain(result)
        })

        return { select: selectFn, selectAll: selectFn }
      }

      if (table === "provider_credential") {
        const credCallIndex = selectFromCalls.filter((t) => t === "provider_credential").length

        // If this is a list call (listCreds provided and it's the first provider_credential select)
        if (listCreds !== undefined && credCallIndex === 1) {
          return makeChainable(listCreds)
        }

        // If this is a getToolSecret lookup
        if (toolSecretCred !== undefined && credCallIndex === 1) {
          return makeChainable(toolSecretCred)
        }

        // Default: upsert existence check
        return makeChainable(existingCred)
      }

      if (table === "credential_audit_log") {
        return makeChainable([])
      }

      return makeChainable(null)
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "credential_audit_log") {
        const execute = vi.fn().mockResolvedValue(undefined)
        const values = vi.fn().mockImplementation((v: unknown) => {
          auditValues(v)
          return { execute }
        })
        return { values }
      }

      // provider_credential insert
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(insertedCred)
      const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
      const values = vi.fn().mockReturnValue({ returningAll })
      return { values }
    }),

    updateTable: vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(updatedCred)
      const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      const whereChain = { where: whereFn, execute, returningAll }
      whereFn.mockReturnValue(whereChain)
      const set = vi.fn().mockReturnValue(whereChain)
      return { set }
    }),

    deleteFrom: vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const chain: Record<string, unknown> = { execute }
      const whereFn = vi.fn().mockReturnValue(chain)
      chain.where = whereFn
      return { where: whereFn, execute }
    }),
  } as unknown as Kysely<Database>

  return { db, auditValues }
}

// ---------------------------------------------------------------------------
// Tests: storeToolSecret
// ---------------------------------------------------------------------------

describe("CredentialService.storeToolSecret", () => {
  it("creates a tool_specific credential for admin users", async () => {
    const insertedCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
      display_label: "brave-search/brave",
    })

    const { db } = buildMockDb({
      userRole: "admin",
      existingCred: null,
      insertedCred,
    })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.storeToolSecret(
      ADMIN_USER_ID,
      "brave-search",
      "brave",
      "sk-test-api-key-12345678",
    )

    expect(result.credentialClass).toBe("tool_specific")
    expect(result.toolName).toBe("brave-search")
    expect(result.provider).toBe("brave")
    expect(result.credentialType).toBe("api_key")
    expect(result.displayLabel).toBe("brave-search/brave")
    expect(result.maskedKey).toMatch(/\*+5678$/)
  })

  it("rejects non-admin users", async () => {
    const { db } = buildMockDb({ userRole: "operator" })

    const service = new CredentialService(db, AUTH_CONFIG)

    await expect(
      service.storeToolSecret(OPERATOR_USER_ID, "brave-search", "brave", "sk-key-12345678"),
    ).rejects.toThrow("Only admins can store tool secrets")
  })

  it("upserts when tool_name + provider already exists", async () => {
    const existingCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
    })
    const updatedCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
      display_label: "brave-search/brave",
    })

    const { db } = buildMockDb({
      userRole: "admin",
      existingCred,
      updatedCred,
    })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.storeToolSecret(
      ADMIN_USER_ID,
      "brave-search",
      "brave",
      "sk-new-key-87654321",
    )

    expect(result.credentialClass).toBe("tool_specific")
    expect(result.toolName).toBe("brave-search")
    // Update path was taken (updateTable was called for provider_credential)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: getToolSecret
// ---------------------------------------------------------------------------

describe("CredentialService.getToolSecret", () => {
  it("retrieves and decrypts a tool secret", async () => {
    const apiKey = "sk-brave-secret-key-1234"
    const toolCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
      api_key_enc: encryptCredential(apiKey, USER_KEY),
    })

    const { db } = buildMockDb({ toolSecretCred: toolCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.getToolSecret("brave-search")

    expect(result).not.toBeNull()
    expect(result!.token).toBe(apiKey)
    expect(result!.credentialId).toBe(CRED_ID)
    expect(result!.provider).toBe("brave")
  })

  it("returns null when no matching tool secret exists", async () => {
    const { db } = buildMockDb({ toolSecretCred: null })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.getToolSecret("nonexistent-tool")

    expect(result).toBeNull()
  })

  it("audit-logs each access as credential_accessed", async () => {
    const toolCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
    })

    const { db, auditValues } = buildMockDb({ toolSecretCred: toolCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.getToolSecret("brave-search")

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "credential_accessed",
        provider: "brave",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        details: expect.objectContaining({ flow: "injection", tool_name: "brave-search" }),
      }),
    )
  })

  it("includes agent/job/tool context in audit log when provided", async () => {
    const toolCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
    })

    const { db, auditValues } = buildMockDb({ toolSecretCred: toolCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.getToolSecret("brave-search", {
      agentId: "agent-111",
      jobId: "job-222",
      toolName: "brave-search",
    })

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "credential_accessed",
        provider: "brave",
        details: {
          flow: "injection",
          tool_name: "brave-search",
          agent_id: "agent-111",
          job_id: "job-222",
        },
      }),
    )
  })

  it("omits absent context fields from audit details", async () => {
    const toolCred = makeCredRow({
      credential_class: "tool_specific",
      tool_name: "brave-search",
      provider: "brave",
    })

    const { db, auditValues } = buildMockDb({ toolSecretCred: toolCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.getToolSecret("brave-search", { agentId: "agent-111" })

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "credential_accessed",
        details: {
          flow: "injection",
          tool_name: "brave-search",
          agent_id: "agent-111",
        },
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: listCredentials with credentialClass filter
// ---------------------------------------------------------------------------

describe("CredentialService.listCredentials", () => {
  it("returns all credentials when no filter is provided", async () => {
    const creds = [
      makeCredRow({ id: "cred-1", credential_class: "llm_provider", provider: "openai" }),
      makeCredRow({
        id: "cred-2",
        credential_class: "tool_specific",
        tool_name: "brave-search",
        provider: "brave",
      }),
    ]

    const { db } = buildMockDb({ listCreds: creds })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.listCredentials(ADMIN_USER_ID)

    expect(result).toHaveLength(2)
    expect(result[0].credentialClass).toBe("llm_provider")
    expect(result[1].credentialClass).toBe("tool_specific")
    expect(result[1].toolName).toBe("brave-search")
  })

  it("filters by credentialClass when provided", async () => {
    const creds = [
      makeCredRow({
        id: "cred-2",
        credential_class: "tool_specific",
        tool_name: "brave-search",
        provider: "brave",
      }),
    ]

    const { db } = buildMockDb({ listCreds: creds })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.listCredentials(ADMIN_USER_ID, {
      credentialClass: "tool_specific",
    })

    expect(result).toHaveLength(1)
    expect(result[0].credentialClass).toBe("tool_specific")
  })

  it("returns empty array when no credentials match", async () => {
    const { db } = buildMockDb({ listCreds: [] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.listCredentials(ADMIN_USER_ID, {
      credentialClass: "tool_specific",
    })

    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: storeOAuthCredential credentialClass param
// ---------------------------------------------------------------------------

describe("CredentialService.storeOAuthCredential", () => {
  it("defaults to llm_provider credential class when not specified", async () => {
    const insertedCred = makeCredRow({
      credential_class: "llm_provider",
      credential_type: "oauth",
      provider: "google-antigravity",
      api_key_enc: null,
      access_token_enc: encryptCredential("oauth-access-token", USER_KEY),
    })

    const { db } = buildMockDb({ existingCred: null, insertedCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.storeOAuthCredential(ADMIN_USER_ID, "google-antigravity", {
      access_token: "oauth-access-token",
      token_type: "Bearer",
    })

    expect(result.credentialClass).toBe("llm_provider")
    expect(result.toolName).toBeNull()
    expect(result.credentialType).toBe("oauth")
  })

  it("accepts explicit credentialClass for user service providers", async () => {
    const insertedCred = makeCredRow({
      credential_class: "user_service",
      credential_type: "oauth",
      provider: "google-workspace",
      api_key_enc: null,
      access_token_enc: encryptCredential("oauth-access-token", USER_KEY),
    })

    const { db } = buildMockDb({ existingCred: null, insertedCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.storeOAuthCredential(
      ADMIN_USER_ID,
      "google-workspace",
      { access_token: "oauth-access-token", token_type: "Bearer" },
      { credentialClass: "user_service" },
    )

    expect(result.credentialClass).toBe("user_service")
    expect(result.toolName).toBeNull()
    expect(result.credentialType).toBe("oauth")
  })
})

// ---------------------------------------------------------------------------
// Tests: backward compatibility
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("storeApiKeyCredential defaults to llm_provider credential class", async () => {
    const insertedCred = makeCredRow({
      credential_class: "llm_provider",
      provider: "openai",
    })

    const { db } = buildMockDb({ existingCred: null, insertedCred })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.storeApiKeyCredential(
      ADMIN_USER_ID,
      "openai",
      "sk-openai-key-12345678",
    )

    expect(result.credentialClass).toBe("llm_provider")
    expect(result.toolName).toBeNull()
  })

  it("CredentialSummary includes credentialClass and toolName fields", async () => {
    const cred = makeCredRow({ credential_class: "llm_provider" })
    const { db } = buildMockDb({ listCreds: [cred] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const [summary] = await service.listCredentials(ADMIN_USER_ID)

    expect(summary).toHaveProperty("credentialClass")
    expect(summary).toHaveProperty("toolName")
    expect(summary.credentialClass).toBe("llm_provider")
    expect(summary.toolName).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: API key end-to-end (store → getAccessToken)
// ---------------------------------------------------------------------------

describe("API key credential flow end-to-end", () => {
  it("storeApiKeyCredential → getAccessToken returns decrypted key", async () => {
    const apiKey = "sk-openai-live-key-12345678"
    const storedCred = makeCredRow({
      credential_class: "llm_provider",
      credential_type: "api_key",
      provider: "openai",
      api_key_enc: encryptCredential(apiKey, USER_KEY),
      access_token_enc: null,
      refresh_token_enc: null,
    })

    // Phase 1: store — mock insert path
    const { db: storeDb } = buildMockDb({ existingCred: null, insertedCred: storedCred })
    const storeService = new CredentialService(storeDb, AUTH_CONFIG)
    const summary = await storeService.storeApiKeyCredential(ADMIN_USER_ID, "openai", apiKey)

    expect(summary.credentialType).toBe("api_key")
    expect(summary.credentialClass).toBe("llm_provider")
    expect(summary.provider).toBe("openai")
    expect(summary.maskedKey).toMatch(/\*+5678$/)

    // Phase 2: resolve — mock the row that was "stored" as existing
    const { db: resolveDb, auditValues } = buildMockDb({ existingCred: storedCred })
    const resolveService = new CredentialService(resolveDb, AUTH_CONFIG)
    const result = await resolveService.getAccessToken(ADMIN_USER_ID, "openai", {
      agentId: "agent-1",
      jobId: "job-1",
    })

    expect(result).not.toBeNull()
    expect(result!.token).toBe(apiKey)
    expect(result!.credentialId).toBe(CRED_ID)

    // Verify audit log was written for agent context
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "credential_accessed",
        provider: "openai",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        details: expect.objectContaining({
          flow: "injection",
          agent_id: "agent-1",
          job_id: "job-1",
        }),
      }),
    )
  })

  it("getAccessToken returns null for non-existent api_key credential", async () => {
    const { db } = buildMockDb({ existingCred: null })
    const service = new CredentialService(db, AUTH_CONFIG)

    const result = await service.getAccessToken(ADMIN_USER_ID, "openai")
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: SUPPORTED_PROVIDERS extensions
// ---------------------------------------------------------------------------

describe("SUPPORTED_PROVIDERS", () => {
  it("includes user service providers with user_service class", () => {
    const googleWorkspace = SUPPORTED_PROVIDERS.find((p) => p.id === "google-workspace")
    expect(googleWorkspace).toBeDefined()
    expect(googleWorkspace!.authType).toBe("oauth")
    expect(googleWorkspace!.credentialClass).toBe("user_service")

    const githubUser = SUPPORTED_PROVIDERS.find((p) => p.id === "github-user")
    expect(githubUser).toBeDefined()
    expect(githubUser!.authType).toBe("oauth")
    expect(githubUser!.credentialClass).toBe("user_service")

    const slackUser = SUPPORTED_PROVIDERS.find((p) => p.id === "slack-user")
    expect(slackUser).toBeDefined()
    expect(slackUser!.authType).toBe("oauth")
    expect(slackUser!.credentialClass).toBe("user_service")
  })

  it("includes all code-paste LLM providers", () => {
    const ids = SUPPORTED_PROVIDERS.map((p) => p.id)
    expect(ids).toContain("google-antigravity")
    expect(ids).toContain("google-gemini-cli")
    expect(ids).toContain("openai-codex")
    expect(ids).toContain("github-copilot")
    expect(ids).toContain("anthropic")
  })

  it("includes tool secret providers", () => {
    const brave = SUPPORTED_PROVIDERS.find((p) => p.id === "brave")
    expect(brave).toBeDefined()
    expect(brave!.authType).toBe("api_key")
    expect(brave!.credentialClass).toBe("tool_specific")
  })

  it("existing providers have no credentialClass (default llm_provider)", () => {
    const openai = SUPPORTED_PROVIDERS.find((p) => p.id === "openai")
    expect(openai).toBeDefined()
    expect(openai!.credentialClass).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: getAuditLog filter parameters
// ---------------------------------------------------------------------------

describe("CredentialService.getAuditLog", () => {
  function buildAuditMockDb() {
    const whereCalls: Array<[unknown, string, unknown]> = []

    const execute = vi.fn().mockResolvedValue([])
    const limitFn = vi.fn().mockReturnValue({ execute })
    const orderBy = vi.fn().mockReturnValue({ limit: limitFn })
    const whereFn: ReturnType<typeof vi.fn> = vi.fn().mockImplementation((...args: unknown[]) => {
      whereCalls.push(args as [unknown, string, unknown])
      return chain
    })
    const chain = { where: whereFn, orderBy, limit: limitFn, execute }
    const selectAll = vi.fn().mockReturnValue(chain)

    const db = {
      selectFrom: vi.fn().mockReturnValue({ selectAll }),
    } as unknown as Kysely<Database>

    return { db, whereCalls }
  }

  it("queries without filters when none provided", async () => {
    const { db, whereCalls } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID)

    // Only the user_account_id where clause
    expect(whereCalls).toHaveLength(1)
    expect(whereCalls[0]).toEqual(["user_account_id", "=", ADMIN_USER_ID])
  })

  it("applies credentialId filter", async () => {
    const { db, whereCalls } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID, { credentialId: CRED_ID })

    expect(whereCalls).toHaveLength(2)
    expect(whereCalls[1]).toEqual(["provider_credential_id", "=", CRED_ID])
  })

  it("applies eventType filter", async () => {
    const { db, whereCalls } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID, { eventType: "credential_accessed" })

    expect(whereCalls).toHaveLength(2)
    expect(whereCalls[1]).toEqual(["event_type", "=", "credential_accessed"])
  })

  it("applies agentId filter via JSONB extraction", async () => {
    const { db, whereCalls } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID, { agentId: "agent-111" })

    expect(whereCalls).toHaveLength(2)
    // The first arg is a Kysely sql template — just check the value matches
    expect(whereCalls[1][1]).toBe("=")
    expect(whereCalls[1][2]).toBe("agent-111")
  })

  it("combines multiple filters", async () => {
    const { db, whereCalls } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID, {
      credentialId: CRED_ID,
      eventType: "credential_accessed",
      agentId: "agent-111",
    })

    // user_account_id + credentialId + eventType + agentId = 4 where clauses
    expect(whereCalls).toHaveLength(4)
  })

  it("respects custom limit", async () => {
    const { db } = buildAuditMockDb()
    const service = new CredentialService(db, AUTH_CONFIG)

    await service.getAuditLog(ADMIN_USER_ID, { limit: 10 })

    // Verify the query was built (no errors)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.selectFrom).toHaveBeenCalledWith("credential_audit_log")
  })
})

// ---------------------------------------------------------------------------
// Tests: deleteCredential
// ---------------------------------------------------------------------------

describe("CredentialService.deleteCredential", () => {
  it("audit-logs before deleting so FK constraint is satisfied", async () => {
    const cred = makeCredRow({
      credential_type: "api_key",
      provider: "openai",
    })

    const { db, auditValues } = buildMockDb({ existingCred: cred })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.deleteCredential(ADMIN_USER_ID, CRED_ID)

    // Audit log was written with correct event type
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "credential_deleted",
        provider: "openai",
        provider_credential_id: CRED_ID,
      }),
    )

    // Credential was deleted
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.deleteFrom).toHaveBeenCalledWith("provider_credential")
  })

  it("uses oauth_disconnected event type for OAuth credentials", async () => {
    const cred = makeCredRow({
      credential_type: "oauth",
      provider: "google-antigravity",
      api_key_enc: null,
      access_token_enc: encryptCredential("oauth-token", USER_KEY),
    })

    const { db, auditValues } = buildMockDb({ existingCred: cred })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.deleteCredential(ADMIN_USER_ID, CRED_ID)

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "oauth_disconnected",
        provider: "google-antigravity",
      }),
    )

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.deleteFrom).toHaveBeenCalledWith("provider_credential")
  })

  it("is a no-op when credential does not exist", async () => {
    const { db, auditValues } = buildMockDb({ existingCred: null })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.deleteCredential(ADMIN_USER_ID, CRED_ID)

    expect(auditValues).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.deleteFrom).not.toHaveBeenCalled()
  })

  it("writes audit log before delete to prevent FK violation", async () => {
    const callOrder: string[] = []

    const cred = makeCredRow({ credential_type: "api_key", provider: "openai" })
    const { db } = buildMockDb({ existingCred: cred })

    // Instrument insertInto and deleteFrom to track call order
    const origInsertInto = db.insertInto.bind(db) as (table: string) => unknown
    ;(db as Record<string, unknown>).insertInto = vi.fn().mockImplementation((table: string) => {
      callOrder.push(`insertInto:${table}`)
      return origInsertInto(table)
    })

    const origDeleteFrom = db.deleteFrom.bind(db) as (table: string) => unknown
    ;(db as Record<string, unknown>).deleteFrom = vi.fn().mockImplementation((table: string) => {
      callOrder.push(`deleteFrom:${table}`)
      return origDeleteFrom(table)
    })

    const service = new CredentialService(db, AUTH_CONFIG)
    await service.deleteCredential(ADMIN_USER_ID, CRED_ID)

    const auditIdx = callOrder.indexOf("insertInto:credential_audit_log")
    const deleteIdx = callOrder.indexOf("deleteFrom:provider_credential")

    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(deleteIdx)
  })
})

// ---------------------------------------------------------------------------
// Tests: getConfiguredProviders (PKCE / empty-secret providers)
// ---------------------------------------------------------------------------

describe("getConfiguredProviders", () => {
  const baseAuth: AuthOAuthConfig = {
    dashboardUrl: "http://localhost:3100",
    credentialMasterKey: "test-key",
    sessionMaxAge: 3600,
  }

  it("includes code-paste providers when their CLIENT_ID env var is set", () => {
    // Env vars set via vi.hoisted above (no CLIENT_SECRET for anthropic)
    const providers = getConfiguredProviders(baseAuth)
    const ids = providers.map((p) => p.id)
    expect(ids).toContain("google-antigravity")
    expect(ids).toContain("openai-codex")
    expect(ids).toContain("anthropic")
  })

  it("includes PKCE-only providers with empty client secret", () => {
    // OAUTH_ANTHROPIC_CLIENT_ID is set but OAUTH_ANTHROPIC_CLIENT_SECRET is not
    const providers = getConfiguredProviders(baseAuth)
    const anthropic = providers.find((p) => p.id === "anthropic")
    expect(anthropic).toBeDefined()
    expect(anthropic!.authType).toBe("oauth")
  })

  it("always includes API key providers", () => {
    const providers = getConfiguredProviders(baseAuth)
    const ids = providers.map((p) => p.id)
    expect(ids).toContain("openai")
    expect(ids).toContain("google-ai-studio")
    expect(ids).toContain("brave")
  })

  it("excludes user-service providers when not in authConfig", () => {
    const providers = getConfiguredProviders(baseAuth)
    const ids = providers.map((p) => p.id)
    expect(ids).not.toContain("google-workspace")
    expect(ids).not.toContain("github-user")
    expect(ids).not.toContain("slack-user")
  })

  it("includes user-service providers when configured in authConfig", () => {
    const auth: AuthOAuthConfig = {
      ...baseAuth,
      googleWorkspace: { clientId: "gw-id", clientSecret: "gw-secret" },
      slackUser: { clientId: "sl-id", clientSecret: "sl-secret" },
    }
    const providers = getConfiguredProviders(auth)
    const ids = providers.map((p) => p.id)
    expect(ids).toContain("google-workspace")
    expect(ids).toContain("slack-user")
    expect(ids).not.toContain("github-user")
  })

  it("returns empty array when authConfig is undefined", () => {
    expect(getConfiguredProviders(undefined)).toEqual([])
  })
})
