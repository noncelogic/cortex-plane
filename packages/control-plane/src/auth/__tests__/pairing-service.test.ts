/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { AgentUserGrant, Database, PairingCode } from "../../db/types.js"
import { PairingService } from "../pairing-service.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const REDEEMER_ID = "cccccccc-1111-2222-3333-444444444444"
const CODE_ID = "dddddddd-1111-2222-3333-444444444444"
const GRANT_ID = "eeeeeeee-1111-2222-3333-444444444444"
const CHANNEL_MAPPING_ID = "ffffffff-1111-2222-3333-444444444444"

const now = new Date()
const futureDate = new Date(Date.now() + 3_600_000)
const pastDate = new Date(Date.now() - 3_600_000)

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeCodeRow(overrides: Partial<PairingCode> = {}): PairingCode {
  return {
    id: CODE_ID,
    code: "ABC234",
    agent_id: AGENT_ID,
    created_by: USER_ID,
    redeemed_by: null,
    redeemed_at: null,
    revoked_at: null,
    expires_at: futureDate,
    created_at: now,
    ...overrides,
  }
}

function makeGrantRow(overrides: Partial<AgentUserGrant> = {}): AgentUserGrant {
  return {
    id: GRANT_ID,
    agent_id: AGENT_ID,
    user_account_id: REDEEMER_ID,
    access_level: "write",
    origin: "pairing_code",
    granted_by: USER_ID,
    rate_limit: null,
    token_budget: null,
    expires_at: null,
    revoked_at: null,
    created_at: now,
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
  const selectAllFn = vi.fn()
  const chain = { where: whereFn, selectAll: selectAllFn, executeTakeFirst, execute }
  whereFn.mockReturnValue(chain)
  selectAllFn.mockReturnValue(chain)
  return chain
}

function mockInsertChain(result: unknown, error?: Error) {
  const executeTakeFirstOrThrow = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(result)
  const valuesFn = vi.fn()
  const returningAllFn = vi.fn()
  const chain = { values: valuesFn, returningAll: returningAllFn, executeTakeFirstOrThrow }
  valuesFn.mockReturnValue(chain)
  returningAllFn.mockReturnValue(chain)
  return chain
}

function mockUpdateChain(result: unknown) {
  const executeTakeFirst = vi.fn().mockResolvedValue(result)
  const execute = vi
    .fn()
    .mockResolvedValue(result == null ? [] : Array.isArray(result) ? result : [result])
  const setFn = vi.fn()
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const returningAllFn = vi.fn()
  const chain = {
    set: setFn,
    where: whereFn,
    returningAll: returningAllFn,
    executeTakeFirst,
    execute,
  }
  setFn.mockReturnValue(chain)
  whereFn.mockReturnValue(chain)
  returningAllFn.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PairingService", () => {
  // -----------------------------------------------------------------------
  // generate
  // -----------------------------------------------------------------------
  describe("generate", () => {
    it("creates a 6-character code from the safe alphabet", async () => {
      const insertChain = mockInsertChain(makeCodeRow())
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.generate(AGENT_ID, USER_ID)

      expect(result.code).toHaveLength(6)
      expect(result.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
      expect(result.expiresAt).toBeInstanceOf(Date)
      expect(db.insertInto).toHaveBeenCalledWith("pairing_code")
    })

    it("respects custom TTL", async () => {
      const insertChain = mockInsertChain(makeCodeRow())
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const before = Date.now()
      const result = await svc.generate(AGENT_ID, USER_ID, 7200)

      const expectedExpiry = before + 7_200_000
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedExpiry - 1000)
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry + 1000)
    })

    it("retries on UNIQUE violation", async () => {
      const uniqueErr = Object.assign(new Error("unique_violation"), { code: "23505" })
      const failChain = mockInsertChain(null, uniqueErr)
      const successChain = mockInsertChain(makeCodeRow())

      let callCount = 0
      const db = {
        insertInto: vi.fn().mockImplementation(() => {
          callCount++
          return callCount === 1 ? failChain : successChain
        }),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.generate(AGENT_ID, USER_ID)

      expect(result.code).toHaveLength(6)
      expect(db.insertInto).toHaveBeenCalledTimes(2)
    })

    it("throws after exhausting retries", async () => {
      const uniqueErr = Object.assign(new Error("unique_violation"), { code: "23505" })
      const failChain = mockInsertChain(null, uniqueErr)
      const db = {
        insertInto: vi.fn().mockReturnValue(failChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      await expect(svc.generate(AGENT_ID, USER_ID)).rejects.toThrow("unique_violation")
      expect(db.insertInto).toHaveBeenCalledTimes(3)
    })
  })

  // -----------------------------------------------------------------------
  // redeem
  // -----------------------------------------------------------------------
  describe("redeem", () => {
    it("rejects an invalid code", async () => {
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(undefined)),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("XXXXXX", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({ success: false, message: "Invalid pairing code" })
    })

    it("rejects an expired code", async () => {
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow({ expires_at: pastDate }))),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({ success: false, message: "Code has expired" })
    })

    it("rejects an already-redeemed code", async () => {
      const db = {
        selectFrom: vi
          .fn()
          .mockReturnValue(
            mockSelectChain(makeCodeRow({ redeemed_at: now, redeemed_by: "someone" })),
          ),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({ success: false, message: "Code already redeemed" })
    })

    it("rejects a revoked code", async () => {
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow({ revoked_at: now }))),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({ success: false, message: "Code has been revoked" })
    })

    it("sets redeemed_by and redeemed_at on success", async () => {
      const updateChain = mockUpdateChain(
        makeCodeRow({ redeemed_at: now, redeemed_by: REDEEMER_ID }),
      )
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow({ agent_id: null }))),
        updateTable: vi.fn().mockReturnValue(updateChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result.success).toBe(true)
      expect(db.updateTable).toHaveBeenCalledWith("pairing_code")

      const setArg = updateChain.set.mock.calls[0]?.[0] as
        | { redeemed_by: string; redeemed_at: Date }
        | undefined
      expect(setArg?.redeemed_by).toBe(REDEEMER_ID)
      expect(setArg?.redeemed_at).toBeInstanceOf(Date)
    })

    it("creates agent_user_grant when agent_id is set", async () => {
      const updateChain = mockUpdateChain(makeCodeRow({ redeemed_at: now }))
      const insertChain = mockInsertChain(makeGrantRow())
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow())),
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({
        success: true,
        message: "Pairing code redeemed",
        grantId: GRANT_ID,
      })
      expect(db.insertInto).toHaveBeenCalledWith("agent_user_grant")
    })

    it("does not create grant when agent_id is null", async () => {
      const updateChain = mockUpdateChain(makeCodeRow({ agent_id: null, redeemed_at: now }))
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow({ agent_id: null }))),
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn(),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result.success).toBe(true)
      expect(result.grantId).toBeUndefined()
      expect(db.insertInto).not.toHaveBeenCalled()
    })

    it("returns failure on concurrent redemption race", async () => {
      // update returns null — another process redeemed first
      const updateChain = mockUpdateChain(null)
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(makeCodeRow())),
        updateTable: vi.fn().mockReturnValue(updateChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

      expect(result).toEqual({
        success: false,
        message: "Code already redeemed or revoked",
      })
    })
  })

  // -----------------------------------------------------------------------
  // listActive
  // -----------------------------------------------------------------------
  describe("listActive", () => {
    it("returns unexpired unredeemed codes for the agent", async () => {
      const codes = [makeCodeRow(), makeCodeRow({ id: "other-id", code: "XYZ789" })]
      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(codes)),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      const result = await svc.listActive(AGENT_ID)

      expect(result).toHaveLength(2)
      expect(db.selectFrom).toHaveBeenCalledWith("pairing_code")
    })
  })

  // -----------------------------------------------------------------------
  // revoke
  // -----------------------------------------------------------------------
  describe("revoke", () => {
    it("updates the code with revoked_at", async () => {
      const updateChain = mockUpdateChain(makeCodeRow({ revoked_at: now }))
      const db = {
        updateTable: vi.fn().mockReturnValue(updateChain),
      } as unknown as Kysely<Database>

      const svc = new PairingService(db)
      await svc.revoke(CODE_ID)

      expect(db.updateTable).toHaveBeenCalledWith("pairing_code")
      const setArg = updateChain.set.mock.calls[0]?.[0] as { revoked_at: Date } | undefined
      expect(setArg?.revoked_at).toBeInstanceOf(Date)
    })
  })
})
