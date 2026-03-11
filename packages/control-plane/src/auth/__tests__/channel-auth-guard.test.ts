/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type {
  Agent,
  AgentUserGrant,
  ChannelMapping,
  Database,
  UserAccount,
} from "../../db/types.js"
import type { AccessRequestService } from "../access-request-service.js"
import { ChannelAuthGuard } from "../channel-auth-guard.js"
import type { PairingService, RedeemResult } from "../pairing-service.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const GRANT_ID = "cccccccc-1111-2222-3333-444444444444"
const CHANNEL_MAPPING_ID = "dddddddd-1111-2222-3333-444444444444"
const BINDING_ID = "eeeeeeee-1111-2222-3333-444444444444"
const ACCESS_REQUEST_ID = "ffffffff-1111-2222-3333-444444444444"

const now = new Date()
const pastDate = new Date(Date.now() - 3_600_000)

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<Agent> = {},
): Pick<Agent, "id" | "auth_model" | "channel_permissions"> {
  return {
    id: AGENT_ID,
    auth_model: "allowlist",
    channel_permissions: {},
    ...overrides,
  }
}

function makeGrant(overrides: Partial<AgentUserGrant> = {}): AgentUserGrant {
  return {
    id: GRANT_ID,
    agent_id: AGENT_ID,
    user_account_id: USER_ID,
    access_level: "write",
    origin: "pairing_code",
    granted_by: null,
    rate_limit: null,
    token_budget: null,
    expires_at: null,
    revoked_at: null,
    created_at: now,
    ...overrides,
  }
}

function makeChannelMapping(
  overrides: Partial<ChannelMapping> = {},
): Pick<ChannelMapping, "id" | "user_account_id"> {
  return {
    id: CHANNEL_MAPPING_ID,
    user_account_id: USER_ID,
    ...overrides,
  }
}

function makeUserAccount(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: USER_ID,
    display_name: null,
    email: null,
    avatar_url: null,
    role: "operator",
    oauth_provider: null,
    oauth_provider_id: null,
    encryption_key_enc: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Chainable Kysely mock helpers
// ---------------------------------------------------------------------------

function mockSelectChain(result: unknown) {
  const executeTakeFirst = vi.fn().mockResolvedValue(result)
  const execute = vi
    .fn()
    .mockResolvedValue(Array.isArray(result) ? result : result == null ? [] : [result])
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const orderByFn: ReturnType<typeof vi.fn> = vi.fn()
  const selectAllFn = vi.fn()
  const selectFn = vi.fn()
  const chain = {
    where: whereFn,
    orderBy: orderByFn,
    selectAll: selectAllFn,
    select: selectFn,
    executeTakeFirst,
    execute,
  }
  whereFn.mockReturnValue(chain)
  orderByFn.mockReturnValue(chain)
  selectAllFn.mockReturnValue(chain)
  selectFn.mockReturnValue(chain)
  return chain
}

function mockInsertChain(result: unknown) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
  const valuesFn = vi.fn()
  const returningAllFn = vi.fn()
  const chain = { values: valuesFn, returningAll: returningAllFn, executeTakeFirstOrThrow }
  valuesFn.mockReturnValue(chain)
  returningAllFn.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Service mock factories
// ---------------------------------------------------------------------------

function makePairingService(overrides: Partial<PairingService> = {}): PairingService {
  return {
    generate: vi.fn(),
    redeem: vi
      .fn()
      .mockResolvedValue({ success: true, message: "Pairing code redeemed", grantId: GRANT_ID }),
    listActive: vi.fn(),
    revoke: vi.fn(),
    ...overrides,
  } as unknown as PairingService
}

function makeAccessRequestService(
  overrides: Partial<AccessRequestService> = {},
): AccessRequestService {
  return {
    create: vi.fn().mockResolvedValue({
      id: ACCESS_REQUEST_ID,
      agent_id: AGENT_ID,
      user_account_id: USER_ID,
      channel_mapping_id: CHANNEL_MAPPING_ID,
      status: "pending",
      message_preview: null,
      reviewed_by: null,
      reviewed_at: null,
      deny_reason: null,
      created_at: now,
    }),
    approve: vi.fn(),
    deny: vi.fn(),
    pendingCounts: vi.fn(),
    ...overrides,
  } as unknown as AccessRequestService
}

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

interface MockDbOpts {
  channelMapping?: Pick<ChannelMapping, "id" | "user_account_id"> | null
  agent?: Pick<Agent, "id" | "auth_model" | "channel_permissions"> | null
  grant?: AgentUserGrant | null
  binding?: { id: string } | null
  newUser?: UserAccount
  newMapping?: ChannelMapping
  newGrant?: AgentUserGrant
}

function buildMockDb(opts: MockDbOpts = {}) {
  const {
    channelMapping = makeChannelMapping(),
    agent = makeAgent(),
    grant = null,
    binding = null,
    newUser = makeUserAccount(),
    newMapping,
    newGrant = makeGrant(),
  } = opts

  const selectFromCalls: string[] = []

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      selectFromCalls.push(table)

      if (table === "channel_mapping") {
        return mockSelectChain(channelMapping)
      }
      if (table === "agent") {
        return mockSelectChain(agent)
      }
      if (table === "agent_user_grant") {
        return mockSelectChain(grant)
      }
      if (table === "agent_channel_binding") {
        return mockSelectChain(binding)
      }
      return mockSelectChain(null)
    }),

    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "user_account") {
        return mockInsertChain(newUser)
      }
      if (table === "channel_mapping") {
        return mockInsertChain(
          newMapping ?? {
            id: CHANNEL_MAPPING_ID,
            user_account_id: newUser.id,
            channel_type: "telegram",
            channel_user_id: "tg-12345",
            metadata: null,
            created_at: now,
          },
        )
      }
      if (table === "agent_user_grant") {
        return mockInsertChain(newGrant)
      }
      return mockInsertChain(null)
    }),
  } as unknown as Kysely<Database>

  return { db, selectFromCalls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelAuthGuard", () => {
  const baseParams = {
    agentId: AGENT_ID,
    channelType: "telegram",
    channelUserId: "tg-12345",
    chatId: "chat-001",
  }

  // -----------------------------------------------------------------------
  // resolveOrCreateIdentity
  // -----------------------------------------------------------------------
  describe("resolveOrCreateIdentity", () => {
    it("returns existing identity when channel_mapping exists", async () => {
      const { db } = buildMockDb()
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const result = await guard.resolveOrCreateIdentity("telegram", "tg-12345")

      expect(result).toEqual({
        userAccountId: USER_ID,
        channelMappingId: CHANNEL_MAPPING_ID,
      })
      expect(db.selectFrom).toHaveBeenCalledWith("channel_mapping")
      expect(db.insertInto).not.toHaveBeenCalled()
    })

    it("creates new user_account + channel_mapping for unknown user", async () => {
      const { db } = buildMockDb({ channelMapping: null })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const result = await guard.resolveOrCreateIdentity("telegram", "tg-new-user", "Alice")

      expect(result.userAccountId).toBe(USER_ID)
      expect(result.channelMappingId).toBe(CHANNEL_MAPPING_ID)
      expect(db.insertInto).toHaveBeenCalledWith("user_account")
      expect(db.insertInto).toHaveBeenCalledWith("channel_mapping")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — allowlist
  // -----------------------------------------------------------------------
  describe("authorize — allowlist", () => {
    it("allows when a valid grant exists", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant(),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
      expect(decision.grantId).toBe(GRANT_ID)
      expect(decision.userId).toBe(USER_ID)
    })

    it("denies with message when no grant exists", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("denied")
      expect(decision.replyToUser).toBeDefined()
    })

    it("uses custom rejection_message from channel_permissions", async () => {
      const customMsg = "Contact admin@example.com for access."
      const { db } = buildMockDb({
        agent: makeAgent({
          auth_model: "allowlist",
          channel_permissions: { rejection_message: customMsg },
        }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.replyToUser).toBe(customMsg)
    })
  })

  // -----------------------------------------------------------------------
  // authorize — approval_queue
  // -----------------------------------------------------------------------
  describe("authorize — approval_queue", () => {
    it("creates access_request when no grant, returns pending", async () => {
      const accessRequestService = makeAccessRequestService()
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "approval_queue" }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService,
      })

      const decision = await guard.authorize({
        ...baseParams,
        messageText: "Hello, can I use this?",
      })

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("pending_approval")
      expect(decision.replyToUser).toBeDefined()
      expect(accessRequestService.create).toHaveBeenCalledWith(
        AGENT_ID,
        USER_ID,
        CHANNEL_MAPPING_ID,
        "Hello, can I use this?",
      )
    })

    it("returns pending without duplicate when request already exists", async () => {
      // AccessRequestService.create() is idempotent — returns existing
      const accessRequestService = makeAccessRequestService()
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "approval_queue" }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService,
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("pending_approval")
      // create() was still called (idempotent), but no error
      expect(accessRequestService.create).toHaveBeenCalledTimes(1)
    })

    it("allows with existing valid grant", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "approval_queue" }),
        grant: makeGrant({ origin: "approval" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — team
  // -----------------------------------------------------------------------
  describe("authorize — team", () => {
    it("auto-grants when agent is bound to the same chat", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "team" }),
        grant: null,
        binding: { id: BINDING_ID },
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("auto_team")
      expect(decision.grantId).toBe(GRANT_ID)
      expect(db.insertInto).toHaveBeenCalledWith("agent_user_grant")
    })

    it("denies when no matching channel binding", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "team" }),
        grant: null,
        binding: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("denied")
    })

    it("allows with existing valid grant (no re-check)", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "team" }),
        grant: makeGrant({ origin: "auto_team" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — open
  // -----------------------------------------------------------------------
  describe("authorize — open", () => {
    it("auto-grants on first message", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("auto_open")
      expect(decision.grantId).toBe(GRANT_ID)
      expect(db.insertInto).toHaveBeenCalledWith("agent_user_grant")
    })

    it("allows with existing grant", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: makeGrant({ origin: "auto_open" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — access_level enforcement
  // -----------------------------------------------------------------------
  describe("authorize — access_level enforcement", () => {
    it("denies write intent when grant has read-only access", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant({ access_level: "read" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize({ ...baseParams, intent: "write" })

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("read_only")
      expect(decision.accessLevel).toBe("read")
      expect(decision.grantId).toBe(GRANT_ID)
      expect(decision.replyToUser).toContain("read-only")
    })

    it("allows read intent when grant has read-only access", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant({ access_level: "read" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize({ ...baseParams, intent: "read" })

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
      expect(decision.accessLevel).toBe("read")
    })

    it("allows write intent when grant has write access", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant({ access_level: "write" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize({ ...baseParams, intent: "write" })

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("granted")
      expect(decision.accessLevel).toBe("write")
    })

    it("defaults intent to write (backward compat)", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant({ access_level: "read" }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      // No intent specified — should default to "write" and deny read-only
      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("read_only")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — revoked / expired grants
  // -----------------------------------------------------------------------
  describe("authorize — revoked grant", () => {
    it("denies with reason revoked", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "allowlist" }),
        grant: makeGrant({ revoked_at: now }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("revoked")
      expect(decision.replyToUser).toContain("revoked")
    })
  })

  describe("authorize — expired grant", () => {
    it("denies with reason expired", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: makeGrant({ expires_at: pastDate }),
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("expired")
      expect(decision.replyToUser).toContain("expired")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — agent not found
  // -----------------------------------------------------------------------
  describe("authorize — agent not found", () => {
    it("denies when agent does not exist", async () => {
      const { db } = buildMockDb({ agent: null })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("denied")
    })
  })

  // -----------------------------------------------------------------------
  // handlePairingCode
  // -----------------------------------------------------------------------
  describe("handlePairingCode", () => {
    it("delegates to PairingService.redeem on valid code", async () => {
      const pairingService = makePairingService()
      const { db } = buildMockDb()
      const guard = new ChannelAuthGuard({
        db,
        pairingService,
        accessRequestService: makeAccessRequestService(),
      })

      const result = await guard.handlePairingCode("ABC123", CHANNEL_MAPPING_ID, USER_ID)

      expect(result.success).toBe(true)
      expect(result.grantId).toBe(GRANT_ID)
      expect(pairingService.redeem).toHaveBeenCalledWith("ABC123", CHANNEL_MAPPING_ID, USER_ID)
    })

    it("returns failure for expired/redeemed code", async () => {
      const redeemResult: RedeemResult = { success: false, message: "Code has expired" }
      const pairingService = makePairingService({
        redeem: vi.fn().mockResolvedValue(redeemResult),
      } as unknown as Partial<PairingService>)
      const { db } = buildMockDb()
      const guard = new ChannelAuthGuard({
        db,
        pairingService,
        accessRequestService: makeAccessRequestService(),
      })

      const result = await guard.handlePairingCode("EXPIRED", CHANNEL_MAPPING_ID, USER_ID)

      expect(result.success).toBe(false)
      expect(result.message).toBe("Code has expired")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — channel allowlist gate
  // -----------------------------------------------------------------------
  describe("authorize — channel allowlist gate", () => {
    it("denies when channel policy is allowlist and user is not allowed", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: null,
      })
      const allowlistService = {
        getPolicy: vi.fn().mockResolvedValue("allowlist"),
        isAllowed: vi.fn().mockResolvedValue(false),
      }
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
        channelAllowlistService: allowlistService as never,
      })

      const decision = await guard.authorize({
        ...baseParams,
        channelConfigId: "channel-config-1",
      })

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("channel_denied")
      expect(decision.replyToUser).toContain("not authorized")
      expect(allowlistService.getPolicy).toHaveBeenCalledWith("channel-config-1")
      expect(allowlistService.isAllowed).toHaveBeenCalledWith("channel-config-1", "tg-12345")
    })

    it("allows when channel policy is allowlist and user IS allowed", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: null,
      })
      const allowlistService = {
        getPolicy: vi.fn().mockResolvedValue("allowlist"),
        isAllowed: vi.fn().mockResolvedValue(true),
      }
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
        channelAllowlistService: allowlistService as never,
      })

      const decision = await guard.authorize({
        ...baseParams,
        channelConfigId: "channel-config-1",
      })

      // Should proceed to the auth model (open → auto_open)
      expect(decision.allowed).toBe(true)
      expect(decision.reason).toBe("auto_open")
    })

    it("skips allowlist check when no channelConfigId provided", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: null,
      })
      const allowlistService = {
        getPolicy: vi.fn().mockResolvedValue("allowlist"),
        isAllowed: vi.fn().mockResolvedValue(false),
      }
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
        channelAllowlistService: allowlistService as never,
      })

      const decision = await guard.authorize(baseParams) // no channelConfigId

      // Should skip allowlist gate entirely
      expect(allowlistService.getPolicy).not.toHaveBeenCalled()
      expect(decision.allowed).toBe(true)
    })

    it("skips allowlist check when channel policy is open", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: null,
      })
      const allowlistService = {
        getPolicy: vi.fn().mockResolvedValue("open"),
        isAllowed: vi.fn().mockResolvedValue(false),
      }
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
        channelAllowlistService: allowlistService as never,
      })

      const decision = await guard.authorize({
        ...baseParams,
        channelConfigId: "channel-config-1",
      })

      // getPolicy was called but isAllowed should NOT be called for "open" policy
      expect(allowlistService.getPolicy).toHaveBeenCalled()
      expect(allowlistService.isAllowed).not.toHaveBeenCalled()
      expect(decision.allowed).toBe(true)
    })

    it("channel deny takes precedence over agent grant", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: "open" }),
        grant: makeGrant(), // user has a grant
      })
      const allowlistService = {
        getPolicy: vi.fn().mockResolvedValue("allowlist"),
        isAllowed: vi.fn().mockResolvedValue(false), // but not on allowlist
      }
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
        channelAllowlistService: allowlistService as never,
      })

      const decision = await guard.authorize({
        ...baseParams,
        channelConfigId: "channel-config-1",
      })

      // Channel deny takes precedence — blocks even with valid grant
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("channel_denied")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — auth_model defaults to allowlist when null
  // -----------------------------------------------------------------------
  describe("authorize — default auth model", () => {
    it("defaults to allowlist when agent.auth_model is null", async () => {
      const { db } = buildMockDb({
        agent: makeAgent({ auth_model: null as never }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      // Default auth_model is "allowlist" → denied without grant
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toBe("denied")
    })
  })

  // -----------------------------------------------------------------------
  // authorize — custom pending_message
  // -----------------------------------------------------------------------
  describe("authorize — custom messages", () => {
    it("uses custom pending_message for approval_queue", async () => {
      const customPendingMsg = "Hold tight, an admin will review your request shortly."
      const accessRequestService = makeAccessRequestService()
      const { db } = buildMockDb({
        agent: makeAgent({
          auth_model: "approval_queue",
          channel_permissions: { pending_message: customPendingMsg },
        }),
        grant: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService,
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.replyToUser).toBe(customPendingMsg)
    })

    it("uses custom rejection_message for team auth model", async () => {
      const customMsg = "Only team members can use this agent."
      const { db } = buildMockDb({
        agent: makeAgent({
          auth_model: "team",
          channel_permissions: { rejection_message: customMsg },
        }),
        grant: null,
        binding: null,
      })
      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.replyToUser).toBe(customMsg)
    })
  })

  // -----------------------------------------------------------------------
  // upsertAutoGrant — concurrent request idempotency
  // -----------------------------------------------------------------------
  describe("concurrent auto-grant handling", () => {
    it("returns existing grant on UNIQUE violation (auto_open)", async () => {
      const uniqueErr = Object.assign(new Error("unique_violation"), { code: "23505" })
      const insertChainMock = mockInsertChain(null)
      insertChainMock.executeTakeFirstOrThrow.mockRejectedValue(uniqueErr)

      let grantSelectCount = 0
      const db = {
        selectFrom: vi.fn().mockImplementation((table: string) => {
          if (table === "channel_mapping") return mockSelectChain(makeChannelMapping())
          if (table === "agent") return mockSelectChain(makeAgent({ auth_model: "open" }))
          if (table === "agent_user_grant") {
            grantSelectCount++
            if (grantSelectCount === 1) {
              // authorize() — no existing grant → triggers handleOpen
              return mockSelectChain(null)
            }
            // upsertAutoGrant fallback after 23505 — return existing grant
            return mockSelectChain({ id: "existing-grant-id" })
          }
          return mockSelectChain(null)
        }),
        insertInto: vi.fn().mockReturnValue(insertChainMock),
      } as unknown as Kysely<Database>

      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      const decision = await guard.authorize(baseParams)

      expect(decision.allowed).toBe(true)
      expect(decision.grantId).toBe("existing-grant-id")
      expect(decision.reason).toBe("auto_open")
    })

    it("rethrows non-UNIQUE errors from auto-grant insert", async () => {
      const otherErr = Object.assign(new Error("connection_refused"), { code: "08006" })
      const insertChainMock = mockInsertChain(null)
      insertChainMock.executeTakeFirstOrThrow.mockRejectedValue(otherErr)

      let selectCallCount = 0
      const db = {
        selectFrom: vi.fn().mockImplementation((table: string) => {
          if (table === "channel_mapping") return mockSelectChain(makeChannelMapping())
          if (table === "agent") return mockSelectChain(makeAgent({ auth_model: "open" }))
          if (table === "agent_user_grant") {
            selectCallCount++
            if (selectCallCount === 1) return mockSelectChain(null)
            return mockSelectChain(null)
          }
          return mockSelectChain(null)
        }),
        insertInto: vi.fn().mockReturnValue(insertChainMock),
      } as unknown as Kysely<Database>

      const guard = new ChannelAuthGuard({
        db,
        pairingService: makePairingService(),
        accessRequestService: makeAccessRequestService(),
      })

      await expect(guard.authorize(baseParams)).rejects.toThrow("connection_refused")
    })
  })
})
