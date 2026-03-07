import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import { ChannelConfigService } from "../channels/channel-config-service.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = "test-master-key-for-channel-config"

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-1111-2222-3333-444444444444",
    type: "telegram",
    name: "My Telegram Bot",
    config_enc: "", // will be set in tests that need it
    enabled: true,
    created_by: "uuuuuuuu-1111-2222-3333-444444444444",
    created_at: new Date("2026-03-01T00:00:00Z"),
    updated_at: new Date("2026-03-01T00:00:00Z"),
    ...overrides,
  }
}

function selectChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? undefined)
  const executeTakeFirstOrThrow = vi.fn().mockImplementation(() => {
    if (rows.length === 0) throw new Error("No result")
    return Promise.resolve(rows[0])
  })
  const execute = vi.fn().mockResolvedValue(rows)
  const terminal = { execute, executeTakeFirst, executeTakeFirstOrThrow }
  const orderBy = vi.fn().mockReturnValue(terminal)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({
    where: whereFn,
    orderBy,
    ...terminal,
  })
  const selectAll = vi.fn().mockReturnValue({ where: whereFn, orderBy, ...terminal })
  const select = vi.fn().mockReturnValue({ where: whereFn, orderBy, ...terminal })
  return { selectAll, select, _where: whereFn, _executeTakeFirst: executeTakeFirst }
}

function insertChain(returnRow: Record<string, unknown>) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(returnRow)
  const returning = vi.fn().mockReturnValue({ executeTakeFirstOrThrow })
  const values = vi.fn().mockReturnValue({ returning })
  return { values }
}

function updateChain(returnRow: Record<string, unknown> | undefined) {
  const executeTakeFirst = vi.fn().mockResolvedValue(returnRow ?? undefined)
  const returning = vi.fn().mockReturnValue({ executeTakeFirst })
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, returning })
  const set = vi.fn().mockReturnValue({ where: whereFn, returning })
  return { set }
}

function deleteChain(numDeletedRows = 1) {
  const executeTakeFirst = vi.fn().mockResolvedValue({ numDeletedRows: BigInt(numDeletedRows) })
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, executeTakeFirst })
  return { where: whereFn }
}

function mockDb(
  opts: {
    selectRows?: Record<string, unknown>[]
    insertReturn?: Record<string, unknown>
    updateReturn?: Record<string, unknown> | null
    deleteCount?: number
  } = {},
) {
  const selectRows = opts.selectRows ?? [makeRow()]
  const insertReturn = opts.insertReturn ?? makeRow()
  const updateReturn = opts.updateReturn === null ? undefined : (opts.updateReturn ?? makeRow())
  const deleteCount = opts.deleteCount ?? 1

  return {
    selectFrom: vi.fn().mockImplementation(() => selectChain(selectRows)),
    insertInto: vi.fn().mockImplementation(() => insertChain(insertReturn)),
    updateTable: vi.fn().mockImplementation(() => updateChain(updateReturn)),
    deleteFrom: vi.fn().mockImplementation(() => deleteChain(deleteCount)),
  } as unknown as Kysely<Database>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelConfigService", () => {
  describe("list", () => {
    it("returns channel config summaries", async () => {
      const db = mockDb({ selectRows: [makeRow(), makeRow({ id: "other", name: "Second Bot" })] })
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.list()

      expect(result).toHaveLength(2)
      expect(result[0]!.name).toBe("My Telegram Bot")
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.selectFrom).toHaveBeenCalledWith("channel_config")
    })
  })

  describe("getById", () => {
    it("returns a summary when found", async () => {
      const db = mockDb()
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.getById("cccccccc-1111-2222-3333-444444444444")

      expect(result).toBeDefined()
      expect(result!.type).toBe("telegram")
    })

    it("returns undefined when not found", async () => {
      const db = mockDb({ selectRows: [] })
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.getById("nonexistent")

      expect(result).toBeUndefined()
    })
  })

  describe("getByIdFull", () => {
    it("returns decrypted config", async () => {
      // Create a config first to get an encrypted value, then read it back
      const createRow = makeRow()
      let capturedConfigEnc = ""
      const insertDb = {
        insertInto: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            capturedConfigEnc = vals.config_enc as string
            return {
              returning: vi.fn().mockReturnValue({
                executeTakeFirstOrThrow: vi.fn().mockResolvedValue(createRow),
              }),
            }
          }),
        })),
        selectFrom: vi.fn(),
        updateTable: vi.fn(),
        deleteFrom: vi.fn(),
      } as unknown as Kysely<Database>

      const svc = new ChannelConfigService(insertDb, MASTER_KEY)
      await svc.create("telegram", "Test Bot", { botToken: "123:ABC" }, null)

      // Now use the encrypted value to test getByIdFull
      const row = makeRow({ config_enc: capturedConfigEnc })
      const readDb = mockDb({ selectRows: [row] })
      const readSvc = new ChannelConfigService(readDb, MASTER_KEY)

      const full = await readSvc.getByIdFull("cccccccc-1111-2222-3333-444444444444")

      expect(full).toBeDefined()
      expect(full!.config).toEqual({ botToken: "123:ABC" })
      expect(full!.name).toBe("My Telegram Bot")
    })
  })

  describe("create", () => {
    it("inserts a new channel config with encrypted data", async () => {
      const db = mockDb()
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.create("telegram", "My Bot", { botToken: "tok" }, "user-1")

      expect(result.type).toBe("telegram")
      expect(result.name).toBe("My Telegram Bot") // from mock return
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.insertInto).toHaveBeenCalledWith("channel_config")
    })
  })

  describe("update", () => {
    it("returns updated summary", async () => {
      const db = mockDb({ updateReturn: makeRow({ name: "Updated Bot" }) })
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.update("cccccccc-1111-2222-3333-444444444444", {
        name: "Updated Bot",
      })

      expect(result).toBeDefined()
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.updateTable).toHaveBeenCalledWith("channel_config")
    })

    it("returns undefined when not found", async () => {
      const db = mockDb({ updateReturn: null })
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.update("nonexistent", { name: "x" })

      expect(result).toBeUndefined()
    })
  })

  describe("delete", () => {
    it("returns true when deleted", async () => {
      const db = mockDb()
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.delete("cccccccc-1111-2222-3333-444444444444")

      expect(result).toBe(true)
    })

    it("returns false when not found", async () => {
      const db = mockDb({ deleteCount: 0 })
      const service = new ChannelConfigService(db, MASTER_KEY)

      const result = await service.delete("nonexistent")

      expect(result).toBe(false)
    })
  })

  describe("encryption round-trip", () => {
    it("encrypts on create and decrypts on listEnabled", async () => {
      // Track what gets inserted
      let capturedConfigEnc = ""
      const baseRow = makeRow()

      const db = {
        insertInto: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            capturedConfigEnc = vals.config_enc as string
            return {
              returning: vi.fn().mockReturnValue({
                executeTakeFirstOrThrow: vi.fn().mockResolvedValue(baseRow),
              }),
            }
          }),
        })),
        selectFrom: vi.fn().mockImplementation(() => {
          // Return the row with the captured encrypted config
          const row = { ...baseRow, config_enc: capturedConfigEnc }
          return selectChain([row])
        }),
        updateTable: vi.fn(),
        deleteFrom: vi.fn(),
      } as unknown as Kysely<Database>

      const service = new ChannelConfigService(db, MASTER_KEY)

      // Create with plain config
      await service.create("telegram", "Test", { botToken: "secret-token-123" }, null)

      // The encrypted value should NOT contain the plaintext
      expect(capturedConfigEnc).not.toContain("secret-token-123")
      expect(capturedConfigEnc.split(".")).toHaveLength(3) // iv.authTag.ciphertext

      // Read back via listEnabled
      const enabled = await service.listEnabled()
      expect(enabled).toHaveLength(1)
      expect(enabled[0]!.config).toEqual({ botToken: "secret-token-123" })
    })

    it("different master keys cannot decrypt each other's data", async () => {
      let capturedConfigEnc = ""
      const baseRow = makeRow()

      const db1 = {
        insertInto: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            capturedConfigEnc = vals.config_enc as string
            return {
              returning: vi.fn().mockReturnValue({
                executeTakeFirstOrThrow: vi.fn().mockResolvedValue(baseRow),
              }),
            }
          }),
        })),
        selectFrom: vi.fn(),
        updateTable: vi.fn(),
        deleteFrom: vi.fn(),
      } as unknown as Kysely<Database>

      const svc1 = new ChannelConfigService(db1, "key-alpha")
      await svc1.create("telegram", "Test", { botToken: "secret" }, null)

      // Try to decrypt with a different key
      const row = { ...baseRow, config_enc: capturedConfigEnc }
      const db2 = mockDb({ selectRows: [row] })
      const svc2 = new ChannelConfigService(db2, "key-beta")

      await expect(svc2.getByIdFull("test-id")).rejects.toThrow()
    })
  })
})
