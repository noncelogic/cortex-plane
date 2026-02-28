import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import { AgentChannelService } from "../channels/agent-channel-service.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    channel_type: "telegram",
    chat_id: "12345",
    is_default: false,
    created_at: new Date(),
    ...overrides,
  }
}

function selectChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
  const execute = vi.fn().mockResolvedValue(rows)
  const terminal = { execute, executeTakeFirst }
  const orderBy = vi.fn().mockReturnValue(terminal)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({
    where: whereFn,
    orderBy,
    ...terminal,
  })
  const selectAll = vi.fn().mockReturnValue({ where: whereFn, orderBy, ...terminal })
  const select = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  return { selectAll, select, _where: whereFn, _executeTakeFirst: executeTakeFirst }
}

function insertChain() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const doUpdateSet = vi.fn().mockReturnValue({ execute })
  const columns = vi.fn().mockReturnValue({ doUpdateSet })
  const onConflict = vi
    .fn()
    .mockImplementation((cb: (oc: { columns: typeof columns }) => unknown) => {
      cb({ columns })
      return { execute }
    })
  const values = vi.fn().mockReturnValue({ onConflict, execute })
  return { values, _execute: execute }
}

function deleteChain(numDeletedRows = 1) {
  const executeTakeFirst = vi.fn().mockResolvedValue({ numDeletedRows: BigInt(numDeletedRows) })
  const execute = vi.fn().mockResolvedValue(undefined)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, executeTakeFirst, execute })
  return { where: whereFn, _executeTakeFirst: executeTakeFirst }
}

function updateChain() {
  const execute = vi.fn().mockResolvedValue(undefined)
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, execute })
  const set = vi.fn().mockReturnValue({ where: whereFn, execute })
  return { set }
}

interface MockDbOptions {
  bindings?: Record<string, unknown>[]
  defaultBinding?: Record<string, unknown> | null
}

function mockDb(opts: MockDbOptions = {}) {
  const { bindings = [makeBinding()], defaultBinding = null } = opts

  // Track call count to selectFrom to differentiate direct vs default lookups
  let selectCallCount = 0

  return {
    selectFrom: vi.fn().mockImplementation(() => {
      selectCallCount++
      if (selectCallCount === 1) {
        return selectChain(bindings)
      }
      // Second call is for default lookup
      return selectChain(defaultBinding ? [defaultBinding] : [])
    }),
    insertInto: vi.fn().mockImplementation(() => insertChain()),
    deleteFrom: vi.fn().mockImplementation(() => deleteChain()),
    updateTable: vi.fn().mockImplementation(() => updateChain()),
  } as unknown as Kysely<Database>
}

// ---------------------------------------------------------------------------
// Tests: resolveAgent
// ---------------------------------------------------------------------------

describe("AgentChannelService", () => {
  describe("resolveAgent", () => {
    it("returns agent_id for direct binding", async () => {
      const db = mockDb({ bindings: [makeBinding()] })
      const service = new AgentChannelService(db)

      const result = await service.resolveAgent("telegram", "12345")

      expect(result).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    })

    it("falls back to default agent when no direct binding", async () => {
      const db = mockDb({
        bindings: [],
        defaultBinding: makeBinding({ is_default: true, agent_id: "default-agent-id" }),
      })
      const service = new AgentChannelService(db)

      const result = await service.resolveAgent("telegram", "99999")

      expect(result).toBe("default-agent-id")
    })

    it("returns null when no binding and no default", async () => {
      const db = mockDb({ bindings: [], defaultBinding: null })
      const service = new AgentChannelService(db)

      const result = await service.resolveAgent("telegram", "99999")

      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: bindChannel
  // ---------------------------------------------------------------------------

  describe("bindChannel", () => {
    it("inserts a binding with upsert", async () => {
      const db = mockDb()
      const service = new AgentChannelService(db)

      await service.bindChannel("agent-1", "telegram", "12345")

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.insertInto).toHaveBeenCalledWith("agent_channel_binding")
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: unbindChannel
  // ---------------------------------------------------------------------------

  describe("unbindChannel", () => {
    it("deletes the binding", async () => {
      const db = mockDb()
      const service = new AgentChannelService(db)

      await service.unbindChannel("agent-1", "telegram", "12345")

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.deleteFrom).toHaveBeenCalledWith("agent_channel_binding")
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: unbindById
  // ---------------------------------------------------------------------------

  describe("unbindById", () => {
    it("returns true when binding is deleted", async () => {
      const db = mockDb()
      const service = new AgentChannelService(db)

      const result = await service.unbindById("agent-1", "binding-1")

      expect(result).toBe(true)
    })

    it("returns false when binding not found", async () => {
      const db = {
        ...mockDb(),
        deleteFrom: vi.fn().mockImplementation(() => deleteChain(0)),
      } as unknown as Kysely<Database>
      const service = new AgentChannelService(db)

      const result = await service.unbindById("agent-1", "nonexistent")

      expect(result).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: listBindings
  // ---------------------------------------------------------------------------

  describe("listBindings", () => {
    it("returns bindings for the agent", async () => {
      const db = mockDb({ bindings: [makeBinding(), makeBinding({ id: "other" })] })
      const service = new AgentChannelService(db)

      const result = await service.listBindings("agent-1")

      expect(result).toHaveLength(2)
    })
  })

  // ---------------------------------------------------------------------------
  // Tests: setDefault
  // ---------------------------------------------------------------------------

  describe("setDefault", () => {
    it("clears existing defaults and sets new one", async () => {
      // When an existing binding exists for this agent + channel_type
      let selectCallCount = 0
      const db = {
        updateTable: vi.fn().mockImplementation(() => updateChain()),
        selectFrom: vi.fn().mockImplementation(() => {
          selectCallCount++
          if (selectCallCount === 1) {
            return selectChain([makeBinding()])
          }
          return selectChain([])
        }),
        insertInto: vi.fn().mockImplementation(() => insertChain()),
      } as unknown as Kysely<Database>

      const service = new AgentChannelService(db)

      await service.setDefault("agent-1", "telegram")

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(db.updateTable).toHaveBeenCalled()
    })
  })
})
