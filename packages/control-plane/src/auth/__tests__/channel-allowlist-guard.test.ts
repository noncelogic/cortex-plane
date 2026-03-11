/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { ChannelAllowlistService } from "../../channels/channel-allowlist-service.js"
import type { Agent, AgentUserGrant, ChannelMapping, Database } from "../../db/types.js"
import type { AccessRequestService } from "../access-request-service.js"
import { ChannelAuthGuard } from "../channel-auth-guard.js"
import type { PairingService } from "../pairing-service.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const CHANNEL_CONFIG_ID = "cccccccc-1111-2222-3333-444444444444"
const CHANNEL_MAPPING_ID = "dddddddd-1111-2222-3333-444444444444"
const GRANT_ID = "eeeeeeee-1111-2222-3333-444444444444"
const now = new Date()

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as channel-auth-guard.test.ts)
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

function makeChannelMapping(): Pick<ChannelMapping, "id" | "user_account_id"> {
  return { id: CHANNEL_MAPPING_ID, user_account_id: USER_ID }
}

function makeAgent(
  overrides: Partial<Agent> = {},
): Pick<Agent, "id" | "auth_model" | "channel_permissions"> {
  return {
    id: AGENT_ID,
    auth_model: "open",
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
    origin: "auto_open",
    granted_by: null,
    rate_limit: null,
    token_budget: null,
    expires_at: null,
    revoked_at: null,
    created_at: now,
    ...overrides,
  }
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

function buildMockDb(opts: {
  channelMapping?: Pick<ChannelMapping, "id" | "user_account_id"> | null
  agent?: Pick<Agent, "id" | "auth_model" | "channel_permissions"> | null
  grant?: AgentUserGrant | null
}) {
  const { channelMapping = makeChannelMapping(), agent = makeAgent(), grant = null } = opts

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === "channel_mapping") return mockSelectChain(channelMapping)
      if (table === "agent") return mockSelectChain(agent)
      if (table === "agent_user_grant") return mockSelectChain(grant)
      return mockSelectChain(null)
    }),
    insertInto: vi.fn().mockImplementation(() => mockInsertChain(makeGrant())),
  } as unknown as Kysely<Database>

  return db
}

function makePairingService(): PairingService {
  return {
    generate: vi.fn(),
    redeem: vi.fn(),
    listActive: vi.fn(),
    revoke: vi.fn(),
  } as unknown as PairingService
}

function makeAccessRequestService(): AccessRequestService {
  return {
    create: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    pendingCounts: vi.fn(),
  } as unknown as AccessRequestService
}

function makeAllowlistService(
  overrides: Partial<ChannelAllowlistService> = {},
): ChannelAllowlistService {
  return {
    getPolicy: vi.fn().mockResolvedValue("open"),
    isAllowed: vi.fn().mockResolvedValue(true),
    listEntries: vi.fn().mockResolvedValue([]),
    addEntry: vi.fn(),
    removeEntry: vi.fn(),
    setPolicy: vi.fn(),
    getAuditLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ChannelAllowlistService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelAuthGuard — channel-level allowlist", () => {
  const baseParams = {
    agentId: AGENT_ID,
    channelType: "telegram",
    channelUserId: "tg-12345",
    chatId: "chat-001",
    channelConfigId: CHANNEL_CONFIG_ID,
  }

  it("denies when channel policy is allowlist and user is NOT in allowlist", async () => {
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "open" }),
      grant: null,
    })
    const allowlistService = makeAllowlistService({
      getPolicy: vi.fn().mockResolvedValue("allowlist"),
      isAllowed: vi.fn().mockResolvedValue(false),
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      channelAllowlistService: allowlistService,
    })

    const decision = await guard.authorize(baseParams)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("channel_denied")
    expect(decision.replyToUser).toContain("not authorized")
  })

  it("allows when channel policy is allowlist and user IS in allowlist", async () => {
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "open" }),
      grant: null,
    })
    const allowlistService = makeAllowlistService({
      getPolicy: vi.fn().mockResolvedValue("allowlist"),
      isAllowed: vi.fn().mockResolvedValue(true),
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      channelAllowlistService: allowlistService,
    })

    const decision = await guard.authorize(baseParams)

    // Passes channel gate, proceeds to agent auth (open → auto_open)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("auto_open")
  })

  it("skips channel check when policy is open", async () => {
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "open" }),
      grant: null,
    })
    const allowlistService = makeAllowlistService({
      getPolicy: vi.fn().mockResolvedValue("open"),
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      channelAllowlistService: allowlistService,
    })

    const decision = await guard.authorize(baseParams)

    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("auto_open")
    // isAllowed should NOT be called when policy is "open"
    expect(allowlistService.isAllowed).not.toHaveBeenCalled()
  })

  it("skips channel check when no channelConfigId is provided", async () => {
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "open" }),
      grant: null,
    })
    const allowlistService = makeAllowlistService({
      getPolicy: vi.fn().mockResolvedValue("allowlist"),
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      channelAllowlistService: allowlistService,
    })

    const decision = await guard.authorize({
      ...baseParams,
      channelConfigId: undefined,
    })

    expect(decision.allowed).toBe(true)
    expect(allowlistService.getPolicy).not.toHaveBeenCalled()
  })

  it("skips channel check when no allowlist service is provided", async () => {
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "open" }),
      grant: null,
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      // No channelAllowlistService
    })

    const decision = await guard.authorize(baseParams)

    // Should proceed to agent-level auth without channel check
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("auto_open")
  })

  it("channel deny takes precedence over agent-level grant", async () => {
    // User has an agent grant but is NOT on the channel allowlist
    const db = buildMockDb({
      agent: makeAgent({ auth_model: "allowlist" }),
      grant: makeGrant(),
    })
    const allowlistService = makeAllowlistService({
      getPolicy: vi.fn().mockResolvedValue("allowlist"),
      isAllowed: vi.fn().mockResolvedValue(false),
    })

    const guard = new ChannelAuthGuard({
      db,
      pairingService: makePairingService(),
      accessRequestService: makeAccessRequestService(),
      channelAllowlistService: allowlistService,
    })

    const decision = await guard.authorize(baseParams)

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe("channel_denied")
  })
})
