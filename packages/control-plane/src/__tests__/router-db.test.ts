import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import { KyselyRouterDb } from "../channels/router-db.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Helpers — mock Kysely query chains
// ---------------------------------------------------------------------------

function mockSelectChain(row: Record<string, unknown> | undefined) {
  const executeTakeFirst = vi.fn().mockResolvedValue(row ?? undefined)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
  const select = vi.fn().mockReturnValue({ where: whereFn, executeTakeFirst })
  const innerJoin = vi.fn().mockReturnValue({ select })
  return { innerJoin }
}

function mockInsertChain(row: Record<string, unknown>) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(row)
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  const values = vi.fn().mockReturnValue({ returning })
  return { values }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KyselyRouterDb", () => {
  describe("resolveUser", () => {
    it("returns resolved user when channel mapping exists", async () => {
      const selectChain = mockSelectChain({
        userAccountId: "user-123",
        channelMappingId: "mapping-456",
      })

      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const routerDb = new KyselyRouterDb(db)
      const result = await routerDb.resolveUser("telegram", "tg-user-1")

      expect(result).toEqual({
        userAccountId: "user-123",
        channelMappingId: "mapping-456",
      })
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.selectFrom).toHaveBeenCalledWith("channel_mapping")
    })

    it("returns undefined when no channel mapping exists", async () => {
      const selectChain = mockSelectChain(undefined)

      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const routerDb = new KyselyRouterDb(db)
      const result = await routerDb.resolveUser("telegram", "unknown-user")

      expect(result).toBeUndefined()
    })
  })

  describe("createUser", () => {
    it("inserts user_account and channel_mapping, returns IDs", async () => {
      const userInsert = mockInsertChain({ id: "new-user-id" })
      const mappingInsert = mockInsertChain({ id: "new-mapping-id" })

      let insertCallCount = 0
      const db = {
        insertInto: vi.fn().mockImplementation((table: string) => {
          insertCallCount++
          if (table === "user_account" || insertCallCount === 1) return userInsert
          return mappingInsert
        }),
      } as unknown as Kysely<Database>

      const routerDb = new KyselyRouterDb(db)
      const result = await routerDb.createUser("telegram", "tg-user-1", "Alice")

      expect(result).toEqual({
        userAccountId: "new-user-id",
        channelMappingId: "new-mapping-id",
      })
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.insertInto).toHaveBeenCalledWith("user_account")
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.insertInto).toHaveBeenCalledWith("channel_mapping")
    })

    it("passes display_name as null when not provided", async () => {
      const userInsert = mockInsertChain({ id: "user-id" })
      const mappingInsert = mockInsertChain({ id: "mapping-id" })

      let callIndex = 0
      const db = {
        insertInto: vi.fn().mockImplementation(() => {
          callIndex++
          return callIndex === 1 ? userInsert : mappingInsert
        }),
      } as unknown as Kysely<Database>

      const routerDb = new KyselyRouterDb(db)
      await routerDb.createUser("discord", "dc-user-1", null)

      expect(userInsert.values).toHaveBeenCalledWith({ display_name: null })
      expect(mappingInsert.values).toHaveBeenCalledWith({
        user_account_id: "user-id",
        channel_type: "discord",
        channel_user_id: "dc-user-1",
      })
    })
  })
})
