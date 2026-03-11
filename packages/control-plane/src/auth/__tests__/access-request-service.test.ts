/* eslint-disable @typescript-eslint/unbound-method */
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"

import type { AccessRequest, AgentUserGrant, Database } from "../../db/types.js"
import { AccessRequestConflictError, AccessRequestService } from "../access-request-service.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-1111-2222-3333-444444444444"
const AGENT_ID_2 = "aaaaaaaa-2222-3333-4444-555555555555"
const USER_ID = "bbbbbbbb-1111-2222-3333-444444444444"
const REVIEWER_ID = "cccccccc-1111-2222-3333-444444444444"
const REQUEST_ID = "dddddddd-1111-2222-3333-444444444444"
const GRANT_ID = "eeeeeeee-1111-2222-3333-444444444444"
const CHANNEL_MAPPING_ID = "ffffffff-1111-2222-3333-444444444444"

const now = new Date()

// ---------------------------------------------------------------------------
// Row factories
// ---------------------------------------------------------------------------

function makeRequestRow(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: REQUEST_ID,
    agent_id: AGENT_ID,
    channel_mapping_id: CHANNEL_MAPPING_ID,
    user_account_id: USER_ID,
    status: "pending",
    message_preview: null,
    reviewed_by: null,
    reviewed_at: null,
    deny_reason: null,
    created_at: now,
    ...overrides,
  }
}

function makeGrantRow(overrides: Partial<AgentUserGrant> = {}): AgentUserGrant {
  return {
    id: GRANT_ID,
    agent_id: AGENT_ID,
    user_account_id: USER_ID,
    access_level: "write",
    origin: "approval",
    granted_by: REVIEWER_ID,
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
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result)
  const execute = vi
    .fn()
    .mockResolvedValue(Array.isArray(result) ? result : result == null ? [] : [result])
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const selectAllFn = vi.fn()
  const selectFn: ReturnType<typeof vi.fn> = vi.fn()
  const orderByFn: ReturnType<typeof vi.fn> = vi.fn()
  const limitFn: ReturnType<typeof vi.fn> = vi.fn()
  const offsetFn: ReturnType<typeof vi.fn> = vi.fn()
  const groupByFn: ReturnType<typeof vi.fn> = vi.fn()
  const chain = {
    where: whereFn,
    selectAll: selectAllFn,
    select: selectFn,
    orderBy: orderByFn,
    limit: limitFn,
    offset: offsetFn,
    groupBy: groupByFn,
    executeTakeFirst,
    executeTakeFirstOrThrow,
    execute,
  }
  whereFn.mockReturnValue(chain)
  selectAllFn.mockReturnValue(chain)
  selectFn.mockReturnValue(chain)
  orderByFn.mockReturnValue(chain)
  limitFn.mockReturnValue(chain)
  offsetFn.mockReturnValue(chain)
  groupByFn.mockReturnValue(chain)
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

function mockUpdateChain() {
  const execute = vi.fn().mockResolvedValue([])
  const setFn = vi.fn()
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  const chain = { set: setFn, where: whereFn, execute }
  setFn.mockReturnValue(chain)
  whereFn.mockReturnValue(chain)
  return chain
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccessRequestService", () => {
  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------
  describe("create", () => {
    it("inserts a new pending request", async () => {
      const insertChain = mockInsertChain(makeRequestRow())
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const result = await svc.create(AGENT_ID, USER_ID, CHANNEL_MAPPING_ID)

      expect(result).toEqual(makeRequestRow())
      expect(db.insertInto).toHaveBeenCalledWith("access_request")
    })

    it("stores message_preview when provided", async () => {
      const row = makeRequestRow({ message_preview: "Hello!" })
      const insertChain = mockInsertChain(row)
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const result = await svc.create(AGENT_ID, USER_ID, CHANNEL_MAPPING_ID, "Hello!")

      expect(result.message_preview).toBe("Hello!")
      const insertedValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertedValues.message_preview).toBe("Hello!")
    })

    it("returns existing request on duplicate (idempotent)", async () => {
      const uniqueErr = Object.assign(new Error("unique_violation"), { code: "23505" })
      const insertChain = mockInsertChain(null, uniqueErr)
      const selectChain = mockSelectChain(makeRequestRow())
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const result = await svc.create(AGENT_ID, USER_ID, CHANNEL_MAPPING_ID)

      expect(result).toEqual(makeRequestRow())
      expect(db.selectFrom).toHaveBeenCalledWith("access_request")
    })

    it("throws on non-unique DB errors", async () => {
      const otherErr = Object.assign(new Error("connection_error"), { code: "08006" })
      const insertChain = mockInsertChain(null, otherErr)
      const db = {
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await expect(svc.create(AGENT_ID, USER_ID, CHANNEL_MAPPING_ID)).rejects.toThrow(
        "connection_error",
      )
    })
  })

  // -----------------------------------------------------------------------
  // approve
  // -----------------------------------------------------------------------
  describe("approve", () => {
    it("approves a pending request and creates a grant", async () => {
      const selectChain = mockSelectChain(makeRequestRow())
      const updateChain = mockUpdateChain()
      const insertChain = mockInsertChain(makeGrantRow())
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const grant = await svc.approve(REQUEST_ID, REVIEWER_ID)

      expect(grant).toEqual(makeGrantRow())
      expect(db.updateTable).toHaveBeenCalledWith("access_request")
      expect(db.insertInto).toHaveBeenCalledWith("agent_user_grant")

      const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(setArg.status).toBe("approved")
      expect(setArg.reviewed_by).toBe(REVIEWER_ID)
      expect(setArg.reviewed_at).toBeInstanceOf(Date)
    })

    it("creates grant with origin 'approval'", async () => {
      const selectChain = mockSelectChain(makeRequestRow())
      const updateChain = mockUpdateChain()
      const insertChain = mockInsertChain(makeGrantRow())
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        updateTable: vi.fn().mockReturnValue(updateChain),
        insertInto: vi.fn().mockReturnValue(insertChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await svc.approve(REQUEST_ID, REVIEWER_ID)

      const insertedValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertedValues.origin).toBe("approval")
      expect(insertedValues.granted_by).toBe(REVIEWER_ID)
    })

    it("throws 409 for non-pending request", async () => {
      const selectChain = mockSelectChain(makeRequestRow({ status: "approved" }))
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await expect(svc.approve(REQUEST_ID, REVIEWER_ID)).rejects.toThrow(AccessRequestConflictError)
      await expect(svc.approve(REQUEST_ID, REVIEWER_ID)).rejects.toThrow(
        "Cannot approve request with status 'approved'",
      )
    })

    it("throws 409 when request not found", async () => {
      const selectChain = mockSelectChain(undefined)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await expect(svc.approve(REQUEST_ID, REVIEWER_ID)).rejects.toThrow(AccessRequestConflictError)
    })
  })

  // -----------------------------------------------------------------------
  // deny
  // -----------------------------------------------------------------------
  describe("deny", () => {
    it("denies a pending request", async () => {
      const selectChain = mockSelectChain(makeRequestRow())
      const updateChain = mockUpdateChain()
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        updateTable: vi.fn().mockReturnValue(updateChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await svc.deny(REQUEST_ID, REVIEWER_ID, "Not authorized")

      expect(db.updateTable).toHaveBeenCalledWith("access_request")

      const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(setArg.status).toBe("denied")
      expect(setArg.reviewed_by).toBe(REVIEWER_ID)
      expect(setArg.reviewed_at).toBeInstanceOf(Date)
      expect(setArg.deny_reason).toBe("Not authorized")
    })

    it("sets deny_reason to null when no reason given", async () => {
      const selectChain = mockSelectChain(makeRequestRow())
      const updateChain = mockUpdateChain()
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
        updateTable: vi.fn().mockReturnValue(updateChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await svc.deny(REQUEST_ID, REVIEWER_ID)

      const setArg = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(setArg.deny_reason).toBeNull()
    })

    it("throws 409 for non-pending request", async () => {
      const selectChain = mockSelectChain(makeRequestRow({ status: "denied" }))
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await expect(svc.deny(REQUEST_ID, REVIEWER_ID)).rejects.toThrow(AccessRequestConflictError)
    })

    it("throws 409 when request not found", async () => {
      const selectChain = mockSelectChain(undefined)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      await expect(svc.deny(REQUEST_ID, REVIEWER_ID)).rejects.toThrow("Access request not found")
    })
  })


  // -----------------------------------------------------------------------
  // pendingCounts
  // -----------------------------------------------------------------------
  describe("pendingCounts", () => {
    it("returns per-agent counts", async () => {
      const rows = [
        { agent_id: AGENT_ID, cnt: "3" },
        { agent_id: AGENT_ID_2, cnt: "1" },
      ]
      const selectChain = mockSelectChain(rows)
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const result = await svc.pendingCounts()

      expect(result).toBeInstanceOf(Map)
      expect(result.get(AGENT_ID)).toBe(3)
      expect(result.get(AGENT_ID_2)).toBe(1)
    })

    it("returns empty map when no pending requests", async () => {
      const selectChain = mockSelectChain([])
      const db = {
        selectFrom: vi.fn().mockReturnValue(selectChain),
      } as unknown as Kysely<Database>

      const svc = new AccessRequestService(db)
      const result = await svc.pendingCounts()

      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })
  })
})
