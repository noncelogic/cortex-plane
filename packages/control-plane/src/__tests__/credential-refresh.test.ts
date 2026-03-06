import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  deriveMasterKey,
  encryptCredential,
  encryptUserKey,
  generateUserKey,
} from "../auth/credential-encryption.js"
import { CredentialService } from "../auth/credential-service.js"
import type { AuthOAuthConfig } from "../config.js"
import type { Database, ProviderCredential } from "../db/types.js"
import { createCredentialRefreshTask } from "../worker/tasks/credential-refresh.js"

// ---------------------------------------------------------------------------
// Mock refreshAccessToken before any imports use it
// ---------------------------------------------------------------------------

const mockRefreshAccessToken = vi.hoisted(() => vi.fn())

vi.mock("../auth/oauth-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../auth/oauth-service.js")>()
  return {
    ...original,
    refreshAccessToken: mockRefreshAccessToken,
  }
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASTER_PASSPHRASE = "test-master-key"
const MASTER_KEY = deriveMasterKey(MASTER_PASSPHRASE)
const USER_KEY = generateUserKey()
const ENCRYPTED_USER_KEY = encryptUserKey(USER_KEY, MASTER_KEY)

const USER_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const CRED_ID_1 = "cccccccc-1111-2222-3333-444444444444"
const CRED_ID_2 = "dddddddd-1111-2222-3333-444444444444"

const AUTH_CONFIG: AuthOAuthConfig = {
  dashboardUrl: "http://localhost:3000",
  credentialMasterKey: MASTER_PASSPHRASE,
  sessionMaxAge: 3600,
  googleAntigravity: {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  },
}

const now = new Date()

function makeOAuthCred(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: CRED_ID_1,
    user_account_id: USER_ID,
    provider: "google-antigravity",
    credential_type: "oauth",
    credential_class: "llm_provider",
    access_token_enc: encryptCredential("old-access-token", USER_KEY),
    refresh_token_enc: encryptCredential("test-refresh-token", USER_KEY),
    api_key_enc: null,
    token_expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10 min from now (within 30-min window)
    scopes: ["openid"],
    account_id: null,
    display_label: "google-antigravity",
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

function makeToolSecretCred(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: CRED_ID_2,
    user_account_id: USER_ID,
    provider: "brave",
    credential_type: "api_key",
    credential_class: "tool_specific",
    access_token_enc: null,
    refresh_token_enc: null,
    api_key_enc: encryptCredential("sk-brave-key", USER_KEY),
    token_expires_at: null,
    scopes: null,
    account_id: null,
    display_label: "brave-search/brave",
    status: "active",
    last_used_at: null,
    last_refresh_at: null,
    error_count: 0,
    last_error: null,
    tool_name: "brave-search",
    metadata: {},
    created_at: now,
    updated_at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

interface MockDbOptions {
  expiringCreds?: ProviderCredential[]
  staleToolSecrets?: ProviderCredential[]
}

function buildMockDb(opts: MockDbOptions = {}) {
  const { expiringCreds = [], staleToolSecrets = [] } = opts

  const auditValues = vi.fn()
  const updateSets = vi.fn()

  function makeWhereChain(result: unknown) {
    const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
    const executeTakeFirst = vi.fn().mockResolvedValue(result)
    const execute = vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result])
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    const chain = {
      where: whereFn,
      executeTakeFirstOrThrow,
      executeTakeFirst,
      execute,
    }
    whereFn.mockReturnValue(chain)
    return chain
  }

  /**
   * Build a provider_credential chain that dispatches on the first
   * where() column: "credential_type" → expiringCreds,
   * "credential_class" → staleToolSecrets.
   */
  function makeCredChain() {
    const expiringChain = makeWhereChain(expiringCreds)
    const staleChain = makeWhereChain(staleToolSecrets)

    const whereFn = vi.fn().mockImplementation((col: string) => {
      if (col === "credential_type") return expiringChain
      if (col === "credential_class") return staleChain
      // fallback: return a generic chain
      return makeWhereChain([])
    })

    return { where: whereFn }
  }

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "user_account") {
        const keyResult = { encryption_key_enc: ENCRYPTED_USER_KEY }
        const selectFn = vi.fn().mockReturnValue(makeWhereChain(keyResult))
        return { select: selectFn, selectAll: selectFn }
      }

      if (table === "provider_credential") {
        const chain = makeCredChain()
        const selectAll = vi.fn().mockReturnValue(chain)
        return { selectAll }
      }

      return { select: vi.fn().mockReturnValue(makeWhereChain(null)) }
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
      return { values: vi.fn().mockReturnValue({ execute: vi.fn() }) }
    }),

    updateTable: vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      const whereChain = { where: whereFn, execute }
      whereFn.mockReturnValue(whereChain)
      const set = vi.fn().mockImplementation((v: unknown) => {
        updateSets(v)
        return whereChain
      })
      return { set }
    }),
  } as unknown as Kysely<Database>

  return { db, auditValues, updateSets }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHelpers() {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as import("graphile-worker").JobHelpers
}

// ---------------------------------------------------------------------------
// Tests: CredentialService.refreshExpiring
// ---------------------------------------------------------------------------

describe("CredentialService.refreshExpiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("refreshes expiring OAuth credentials and returns counts", async () => {
    const cred = makeOAuthCred()
    const { db, auditValues, updateSets } = buildMockDb({ expiringCreds: [cred] })

    mockRefreshAccessToken.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 1, failed: 0 })
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()

    // Verify update sets active status and resets error_count
    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        error_count: 0,
        last_error: null,
      }) as Record<string, unknown>,
    )

    // Verify audit log
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "token_refreshed",
        provider: "google-antigravity",
      }) as Record<string, unknown>,
    )
  })

  it("returns zero counts when no credentials need refresh", async () => {
    const { db } = buildMockDb({ expiringCreds: [] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 0, failed: 0 })
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it("increments error_count on failure and keeps status active below threshold", async () => {
    const cred = makeOAuthCred({ error_count: 1 })
    const { db, auditValues, updateSets } = buildMockDb({ expiringCreds: [cred] })

    mockRefreshAccessToken.mockRejectedValue(new Error("Token endpoint unreachable"))

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 0, failed: 1 })

    // error_count goes from 1 → 2, still below 3 → status stays active
    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        error_count: 2,
        last_error: "Token endpoint unreachable",
        status: "active",
      }) as Record<string, unknown>,
    )

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "refresh_failed",
        provider: "google-antigravity",
        details: expect.objectContaining({
          error: "Token endpoint unreachable",
          error_count: 2,
        }) as Record<string, unknown>,
      }) as Record<string, unknown>,
    )
  })

  it("sets status to error after 3 consecutive failures", async () => {
    const cred = makeOAuthCred({ error_count: 2 })
    const { db, updateSets } = buildMockDb({ expiringCreds: [cred] })

    mockRefreshAccessToken.mockRejectedValue(new Error("Provider unavailable"))

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 0, failed: 1 })

    // error_count goes from 2 → 3, at threshold → status becomes error
    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        error_count: 3,
        status: "error",
      }) as Record<string, unknown>,
    )
  })

  it("skips credentials with no provider config", async () => {
    const cred = makeOAuthCred({ provider: "unknown-provider" })
    const { db } = buildMockDb({ expiringCreds: [cred] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 0, failed: 0 })
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it("resets error_count to 0 on successful refresh after previous failures", async () => {
    const cred = makeOAuthCred({ error_count: 2, last_error: "previous error" })
    const { db, updateSets } = buildMockDb({ expiringCreds: [cred] })

    mockRefreshAccessToken.mockResolvedValue({
      access_token: "new-access-token",
      expires_in: 3600,
      token_type: "Bearer",
    })

    const service = new CredentialService(db, AUTH_CONFIG)
    const result = await service.refreshExpiring()

    expect(result).toEqual({ refreshed: 1, failed: 0 })

    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        error_count: 0,
        last_error: null,
        status: "active",
      }) as Record<string, unknown>,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: CredentialService.emitRotationReminders
// ---------------------------------------------------------------------------

describe("CredentialService.emitRotationReminders", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("emits rotation_due audit events for stale tool secrets", async () => {
    const staleCred = makeToolSecretCred()
    const { db, auditValues } = buildMockDb({ staleToolSecrets: [staleCred] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const count = await service.emitRotationReminders()

    expect(count).toBe(1)
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "rotation_due",
        provider: "brave",
        details: expect.objectContaining({
          tool_name: "brave-search",
        }) as Record<string, unknown>,
      }) as Record<string, unknown>,
    )
  })

  it("returns 0 when no stale secrets exist", async () => {
    const { db } = buildMockDb({ staleToolSecrets: [] })

    const service = new CredentialService(db, AUTH_CONFIG)
    const count = await service.emitRotationReminders()

    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: createCredentialRefreshTask
// ---------------------------------------------------------------------------

describe("createCredentialRefreshTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("calls refreshExpiring and emitRotationReminders and logs summary", async () => {
    const cred = makeOAuthCred()
    const staleCred = makeToolSecretCred()
    const { db } = buildMockDb({ expiringCreds: [cred], staleToolSecrets: [staleCred] })

    mockRefreshAccessToken.mockResolvedValue({
      access_token: "new-access-token",
      expires_in: 3600,
      token_type: "Bearer",
    })

    const task = createCredentialRefreshTask(db, AUTH_CONFIG)
    const helpers = makeHelpers()

    await task({}, helpers)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).toHaveBeenCalledWith("credential_refresh: Refreshed 1 tokens, 0 failures")
    expect(info).toHaveBeenCalledWith("credential_refresh: 1 tool secret(s) due for rotation")
  })

  it("does not log when nothing to refresh", async () => {
    const { db } = buildMockDb({ expiringCreds: [], staleToolSecrets: [] })

    const task = createCredentialRefreshTask(db, AUTH_CONFIG)
    const helpers = makeHelpers()

    await task({}, helpers)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).not.toHaveBeenCalled()
  })
})
