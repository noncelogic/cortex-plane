/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import { ChannelAllowlistService } from "../channels/channel-allowlist-service.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_ID = "cccccccc-1111-2222-3333-444444444444"
const ENTRY_ID = "eeeeeeee-1111-2222-3333-444444444444"
const OPERATOR_ID = "oooooooo-1111-2222-3333-444444444444"
const now = new Date()

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
  const limitFn: ReturnType<typeof vi.fn> = vi.fn()
  const selectAllFn = vi.fn()
  const selectFn = vi.fn()
  const chain = {
    where: whereFn,
    orderBy: orderByFn,
    limit: limitFn,
    selectAll: selectAllFn,
    select: selectFn,
    executeTakeFirst,
    execute,
  }
  whereFn.mockReturnValue(chain)
  orderByFn.mockReturnValue(chain)
  limitFn.mockReturnValue(chain)
  selectAllFn.mockReturnValue(chain)
  selectFn.mockReturnValue(chain)
  return chain
}

function mockInsertChain(result: unknown) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
  const execute = vi.fn().mockResolvedValue(undefined)
  const valuesFn = vi.fn()
  const returningAllFn = vi.fn()
  const onConflictFn = vi.fn()
  const chain = {
    values: valuesFn,
    returningAll: returningAllFn,
    onConflict: onConflictFn,
    executeTakeFirstOrThrow,
    execute,
  }
  valuesFn.mockReturnValue(chain)
  returningAllFn.mockReturnValue(chain)
  onConflictFn.mockReturnValue(chain)
  return chain
}

function mockUpdateChain(numUpdatedRows: number) {
  const executeTakeFirst = vi.fn().mockResolvedValue({ numUpdatedRows: BigInt(numUpdatedRows) })
  const setFn = vi.fn()
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const chain = { set: setFn, where: whereFn, executeTakeFirst }
  setFn.mockReturnValue(chain)
  whereFn.mockReturnValue(chain)
  return chain
}

function mockDeleteChain(result: unknown) {
  const executeTakeFirst = vi.fn().mockResolvedValue(result)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const returningAllFn = vi.fn()
  const chain = { where: whereFn, returningAll: returningAllFn, executeTakeFirst }
  whereFn.mockReturnValue(chain)
  returningAllFn.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    channel_config_id: CHANNEL_ID,
    platform_user_id: "tg-12345",
    display_name: "Alice",
    note: null,
    added_by: OPERATOR_ID,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function makeAuditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    channel_config_id: CHANNEL_ID,
    action: "entry_added",
    platform_user_id: "tg-12345",
    performed_by: OPERATOR_ID,
    detail: {},
    created_at: now,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelAllowlistService", () => {
  describe("listEntries", () => {
    it("returns all entries for a channel", async () => {
      const entries = [makeEntry(), makeEntry({ id: "fff", platform_user_id: "tg-67890" })]
      const selectChain = mockSelectChain(entries)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        insertInto: vi.fn().mockReturnValue(mockInsertChain(undefined)),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.listEntries(CHANNEL_ID)

      expect(result).toEqual(entries)
      expect(db.selectFrom).toHaveBeenCalledWith("channel_allowlist")
    })
  })

  describe("addEntry", () => {
    it("inserts a new allowlist entry and records audit", async () => {
      const entry = makeEntry()
      const insertChain = mockInsertChain(entry)
      const auditChain = mockInsertChain(undefined)
      let insertCall = 0

      const db = {
        selectFrom: vi.fn().mockReturnValue(mockSelectChain(null)),
        insertInto: vi.fn().mockImplementation(() => {
          insertCall++
          return insertCall === 1 ? insertChain : auditChain
        }),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.addEntry(CHANNEL_ID, "tg-12345", OPERATOR_ID, "Alice")

      expect(result).toEqual(entry)
      expect(db.insertInto).toHaveBeenCalledWith("channel_allowlist")
      expect(db.insertInto).toHaveBeenCalledWith("channel_allowlist_audit")
    })
  })

  describe("removeEntry", () => {
    it("deletes entry and records audit", async () => {
      const entry = makeEntry()
      const deleteChain = mockDeleteChain(entry)
      const auditChain = mockInsertChain(undefined)

      const db = {
        deleteFrom: vi.fn().mockReturnValue(deleteChain),
        insertInto: vi.fn().mockReturnValue(auditChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.removeEntry(ENTRY_ID, OPERATOR_ID)

      expect(result).toEqual(entry)
      expect(db.deleteFrom).toHaveBeenCalledWith("channel_allowlist")
      expect(db.insertInto).toHaveBeenCalledWith("channel_allowlist_audit")
    })

    it("returns undefined when entry not found", async () => {
      const deleteChain = mockDeleteChain(undefined)

      const db = {
        deleteFrom: vi.fn().mockReturnValue(deleteChain),
        insertInto: vi.fn().mockReturnValue(mockInsertChain(undefined)),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.removeEntry("nonexistent", OPERATOR_ID)

      expect(result).toBeUndefined()
      // No audit should be recorded for non-existent entry
      expect(db.insertInto).not.toHaveBeenCalled()
    })
  })

  describe("isAllowed", () => {
    it("returns true when entry exists", async () => {
      const selectChain = mockSelectChain({ id: ENTRY_ID })
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.isAllowed(CHANNEL_ID, "tg-12345")

      expect(result).toBe(true)
    })

    it("returns false when entry does not exist", async () => {
      const selectChain = mockSelectChain(null)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.isAllowed(CHANNEL_ID, "tg-unknown")

      expect(result).toBe(false)
    })
  })

  describe("getPolicy", () => {
    it("returns the inbound policy for a channel", async () => {
      const selectChain = mockSelectChain({ inbound_policy: "allowlist" })
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.getPolicy(CHANNEL_ID)

      expect(result).toBe("allowlist")
    })

    it("returns undefined when channel not found", async () => {
      const selectChain = mockSelectChain(null)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.getPolicy("nonexistent")

      expect(result).toBeUndefined()
    })
  })

  describe("setPolicy", () => {
    it("updates policy and records audit", async () => {
      const updateChain = mockUpdateChain(1)
      const auditChain = mockInsertChain(undefined)

      const db = {
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn().mockReturnValue(auditChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.setPolicy(CHANNEL_ID, "allowlist", OPERATOR_ID)

      expect(result).toBe(true)
      expect(db.updateTable).toHaveBeenCalledWith("channel_config")
      expect(db.insertInto).toHaveBeenCalledWith("channel_allowlist_audit")
    })

    it("returns false when channel not found", async () => {
      const updateChain = mockUpdateChain(0)

      const db = {
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn().mockReturnValue(mockInsertChain(undefined)),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.setPolicy("nonexistent", "open", OPERATOR_ID)

      expect(result).toBe(false)
      // No audit should be recorded when channel not found
      expect(db.insertInto).not.toHaveBeenCalled()
    })
  })

  describe("getAuditLog", () => {
    it("returns audit entries in descending order", async () => {
      const entries = [makeAuditEntry(), makeAuditEntry({ action: "entry_removed" })]
      const selectChain = mockSelectChain(entries)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const service = new ChannelAllowlistService(db)
      const result = await service.getAuditLog(CHANNEL_ID)

      expect(result).toEqual(entries)
      expect(db.selectFrom).toHaveBeenCalledWith("channel_allowlist_audit")
    })
  })
})
