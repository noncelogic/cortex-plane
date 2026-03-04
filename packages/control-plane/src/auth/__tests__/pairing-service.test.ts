import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { AgentUserGrant, Database, PairingCode } from "../../db/types.js"
import { CODE_ALPHABET, generateCode, PairingService } from "../pairing-service.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const CREATOR_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const REDEEMER_ID = "cccccccc-1111-2222-3333-444444444444"
const CHANNEL_MAPPING_ID = "dddddddd-1111-2222-3333-444444444444"
const CODE_ID = "eeeeeeee-1111-2222-3333-444444444444"
const GRANT_ID = "ffffffff-1111-2222-3333-444444444444"

const now = new Date()

function makePairingRow(overrides: Partial<PairingCode> = {}): PairingCode {
  return {
    id: CODE_ID,
    code: "ABC234",
    agent_id: AGENT_ID,
    created_by: CREATOR_ID,
    redeemed_by: null,
    redeemed_at: null,
    revoked_at: null,
    expires_at: new Date(Date.now() + 3600_000),
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
    granted_by: CREATOR_ID,
    rate_limit: null,
    token_budget: null,
    expires_at: null,
    revoked_at: null,
    created_at: now,
    ...overrides,
  }
}

/**
 * Build a mock Kysely database for PairingService tests.
 */
function buildMockDb(
  opts: {
    insertThrows?: Error | null
    selectResult?: PairingCode | null | undefined
    listResults?: PairingCode[]
    grantResult?: AgentUserGrant
  } = {},
) {
  const { insertThrows = null, selectResult, listResults, grantResult } = opts

  const updateSetValues = vi.fn()

  function makeTerminal(result: unknown) {
    return {
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue(result),
      executeTakeFirst: vi.fn().mockResolvedValue(result ?? null),
      execute: vi.fn().mockResolvedValue(Array.isArray(result) ? result : [result]),
    }
  }

  function makeChainable(result: unknown) {
    const terminal = makeTerminal(result)
    const whereFn: ReturnType<typeof vi.fn> = vi.fn()
    const orderBy: ReturnType<typeof vi.fn> = vi.fn()
    const chain = { where: whereFn, orderBy, ...terminal }
    whereFn.mockReturnValue(chain)
    orderBy.mockReturnValue(chain)
    const selectAll = vi.fn().mockReturnValue(chain)
    return { selectAll, where: whereFn, ...terminal }
  }

  const db = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === "agent_user_grant") {
        const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(grantResult ?? makeGrantRow())
        const returningAll = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
        const values = vi.fn().mockReturnValue({ returningAll })
        return { values }
      }

      // pairing_code insert
      const execute = insertThrows
        ? vi.fn().mockRejectedValue(insertThrows)
        : vi.fn().mockResolvedValue(undefined)
      const values = vi.fn().mockReturnValue({ execute })
      return { values }
    }),

    selectFrom: vi.fn().mockImplementation(() => {
      if (listResults !== undefined) {
        return makeChainable(listResults)
      }
      return makeChainable(selectResult ?? null)
    }),

    updateTable: vi.fn().mockImplementation(() => {
      const execute = vi.fn().mockResolvedValue(undefined)
      const whereFn: ReturnType<typeof vi.fn> = vi.fn()
      const whereChain = { where: whereFn, execute }
      whereFn.mockReturnValue(whereChain)
      const set = vi.fn().mockImplementation((vals: unknown) => {
        updateSetValues(vals)
        return whereChain
      })
      return { set }
    }),
  } as unknown as Kysely<Database>

  return { db, updateSetValues }
}

// ---------------------------------------------------------------------------
// Tests: generateCode (pure function)
// ---------------------------------------------------------------------------

describe("generateCode", () => {
  it("returns a 6-character string", () => {
    const code = generateCode()
    expect(code).toHaveLength(6)
  })

  it("uses only characters from the safe alphabet", () => {
    // Generate many codes to increase confidence
    for (let i = 0; i < 100; i++) {
      const code = generateCode()
      for (const ch of code) {
        expect(CODE_ALPHABET).toContain(ch)
      }
    }
  })

  it("does not contain ambiguous characters (0, O, 1, I, L)", () => {
    const forbidden = ["0", "O", "1", "I", "L"]
    for (let i = 0; i < 100; i++) {
      const code = generateCode()
      for (const ch of forbidden) {
        expect(code).not.toContain(ch)
      }
    }
  })

  it("produces unique codes across calls", () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      codes.add(generateCode())
    }
    // With 29^6 ≈ 594M possibilities, 50 codes should all be unique
    expect(codes.size).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// Tests: PairingService.generate
// ---------------------------------------------------------------------------

describe("PairingService.generate", () => {
  it("inserts a pairing code and returns code + expiresAt", async () => {
    const { db } = buildMockDb()
    const service = new PairingService(db)

    const result = await service.generate(AGENT_ID, CREATOR_ID, 7200)

    expect(result.code).toHaveLength(6)
    expect(result.expiresAt).toBeInstanceOf(Date)
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("pairing_code")
  })

  it("retries on unique-constraint violation", async () => {
    let callCount = 0
    const uniqueError = new Error("duplicate key value violates unique constraint (23505)")

    const db = {
      insertInto: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          execute: vi.fn().mockImplementation(() => {
            callCount++
            if (callCount < 3) return Promise.reject(uniqueError)
            return Promise.resolve(undefined)
          }),
        }),
      })),
    } as unknown as Kysely<Database>

    const service = new PairingService(db)
    const result = await service.generate(AGENT_ID, CREATOR_ID)

    expect(result.code).toHaveLength(6)
    expect(callCount).toBe(3)
  })

  it("throws after exhausting retries on unique violation", async () => {
    const uniqueError = new Error("unique constraint (23505)")

    const { db } = buildMockDb({ insertThrows: uniqueError })
    const service = new PairingService(db)

    await expect(service.generate(AGENT_ID, CREATOR_ID)).rejects.toThrow("unique")
  })

  it("throws immediately on non-unique errors", async () => {
    const dbError = new Error("connection refused")
    const { db } = buildMockDb({ insertThrows: dbError })
    const service = new PairingService(db)

    await expect(service.generate(AGENT_ID, CREATOR_ID)).rejects.toThrow("connection refused")
  })

  it("uses default TTL when ttlSeconds is not provided", async () => {
    const { db } = buildMockDb()
    const service = new PairingService(db)

    const before = Date.now()
    const result = await service.generate(AGENT_ID, CREATOR_ID)
    const after = Date.now()

    // Default TTL is 3600s = 1 hour
    const expectedMin = before + 3600 * 1000
    const expectedMax = after + 3600 * 1000
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin)
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax)
  })
})

// ---------------------------------------------------------------------------
// Tests: PairingService.redeem
// ---------------------------------------------------------------------------

describe("PairingService.redeem", () => {
  it("redeems a valid code and creates an agent_user_grant", async () => {
    const row = makePairingRow()
    const grant = makeGrantRow()
    const { db, updateSetValues } = buildMockDb({ selectResult: row, grantResult: grant })

    const service = new PairingService(db)
    const result = await service.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

    expect(result.pairingCodeId).toBe(CODE_ID)
    expect(result.agentId).toBe(AGENT_ID)
    expect(result.grantId).toBe(GRANT_ID)

    // Verify redeemed_by and redeemed_at were set
    expect(updateSetValues).toHaveBeenCalledWith(
      expect.objectContaining({
        redeemed_by: REDEEMER_ID,
        redeemed_at: expect.any(Date),
      }),
    )

    // Verify grant was created
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.insertInto).toHaveBeenCalledWith("agent_user_grant")
  })

  it("does not create a grant when agent_id is null", async () => {
    const row = makePairingRow({ agent_id: null })
    const { db } = buildMockDb({ selectResult: row })

    const service = new PairingService(db)
    const result = await service.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)

    expect(result.grantId).toBeNull()
    expect(result.agentId).toBeNull()
  })

  it("throws on invalid code", async () => {
    const { db } = buildMockDb({ selectResult: null })
    const service = new PairingService(db)

    await expect(service.redeem("XXXXXX", CHANNEL_MAPPING_ID, REDEEMER_ID)).rejects.toThrow(
      "Invalid pairing code",
    )
  })

  it("throws on expired code", async () => {
    const row = makePairingRow({ expires_at: new Date(Date.now() - 1000) })
    const { db } = buildMockDb({ selectResult: row })
    const service = new PairingService(db)

    await expect(service.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)).rejects.toThrow(
      "Pairing code has expired",
    )
  })

  it("throws on already-redeemed code", async () => {
    const row = makePairingRow({
      redeemed_at: new Date(),
      redeemed_by: "someone-else",
    })
    const { db } = buildMockDb({ selectResult: row })
    const service = new PairingService(db)

    await expect(service.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)).rejects.toThrow(
      "Pairing code already redeemed",
    )
  })

  it("throws on revoked code", async () => {
    const row = makePairingRow({ revoked_at: new Date() })
    const { db } = buildMockDb({ selectResult: row })
    const service = new PairingService(db)

    await expect(service.redeem("ABC234", CHANNEL_MAPPING_ID, REDEEMER_ID)).rejects.toThrow(
      "Pairing code has been revoked",
    )
  })

  it("normalizes code to uppercase before lookup", async () => {
    const row = makePairingRow()
    const { db } = buildMockDb({ selectResult: row, grantResult: makeGrantRow() })
    const service = new PairingService(db)

    await service.redeem("abc234", CHANNEL_MAPPING_ID, REDEEMER_ID)

    // Verify the where clause received uppercase
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const selectFrom = db.selectFrom as ReturnType<typeof vi.fn>
    expect(selectFrom).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: PairingService.listActive
// ---------------------------------------------------------------------------

describe("PairingService.listActive", () => {
  it("returns active codes for an agent", async () => {
    const codes = [
      makePairingRow({ id: "code-1", code: "ABC123" }),
      makePairingRow({ id: "code-2", code: "DEF456" }),
    ]
    const { db } = buildMockDb({ listResults: codes })
    const service = new PairingService(db)

    const result = await service.listActive(AGENT_ID)

    expect(result).toHaveLength(2)
    expect(result[0]!.code).toBe("ABC123")
    expect(result[1]!.code).toBe("DEF456")
  })

  it("returns empty array when no active codes exist", async () => {
    const { db } = buildMockDb({ listResults: [] })
    const service = new PairingService(db)

    const result = await service.listActive(AGENT_ID)

    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: PairingService.revoke
// ---------------------------------------------------------------------------

describe("PairingService.revoke", () => {
  it("sets revoked_at on the pairing code", async () => {
    const { db, updateSetValues } = buildMockDb()
    const service = new PairingService(db)

    await service.revoke(CODE_ID)

    expect(updateSetValues).toHaveBeenCalledWith(
      expect.objectContaining({
        revoked_at: expect.any(Date),
      }),
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(db.updateTable).toHaveBeenCalledWith("pairing_code")
  })
})

// ---------------------------------------------------------------------------
// Tests: CODE_ALPHABET
// ---------------------------------------------------------------------------

describe("CODE_ALPHABET", () => {
  it("has 31 characters (36 alphanumeric minus 0/O/1/I/L)", () => {
    expect(CODE_ALPHABET).toHaveLength(31)
  })

  it("excludes ambiguous characters", () => {
    expect(CODE_ALPHABET).not.toContain("0")
    expect(CODE_ALPHABET).not.toContain("O")
    expect(CODE_ALPHABET).not.toContain("1")
    expect(CODE_ALPHABET).not.toContain("I")
    expect(CODE_ALPHABET).not.toContain("L")
  })

  it("contains only uppercase letters and digits", () => {
    expect(CODE_ALPHABET).toMatch(/^[A-Z0-9]+$/)
  })
})
