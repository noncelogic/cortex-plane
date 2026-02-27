import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import { ApprovalService } from "../approval/service.js"
import { hashApprovalToken } from "../approval/token.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockDb() {
  const mockResult = {
    executeTakeFirst: vi.fn(),
    executeTakeFirstOrThrow: vi.fn(),
    execute: vi.fn(),
  }

  const mockChain = {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    executeTakeFirst: mockResult.executeTakeFirst,
    executeTakeFirstOrThrow: mockResult.executeTakeFirstOrThrow,
    execute: mockResult.execute,
  }

  const txMockResult = {
    executeTakeFirst: vi.fn(),
    executeTakeFirstOrThrow: vi.fn(),
    execute: vi.fn(),
  }

  const txMockChain = {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    executeTakeFirst: txMockResult.executeTakeFirst,
    executeTakeFirstOrThrow: txMockResult.executeTakeFirstOrThrow,
    execute: txMockResult.execute,
  }

  const db = {
    selectFrom: vi.fn().mockReturnValue(mockChain),
    updateTable: vi.fn().mockReturnValue(mockChain),
    insertInto: vi.fn().mockReturnValue(mockChain),
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          insertInto: vi.fn().mockReturnValue(txMockChain),
          updateTable: vi.fn().mockReturnValue(txMockChain),
          selectFrom: vi.fn().mockReturnValue(txMockChain),
        }
        await fn(tx)
      }),
    }),
    _mockChain: mockChain,
    _mockResult: mockResult,
    _txMockChain: txMockChain,
    _txMockResult: txMockResult,
  }

  return db as unknown as Kysely<Database> & {
    _mockChain: typeof mockChain
    _mockResult: typeof mockResult
    _txMockChain: typeof txMockChain
    _txMockResult: typeof txMockResult
  }
}

function makeMockWorkerUtils() {
  return {
    addJob: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApprovalService", () => {
  let db: ReturnType<typeof makeMockDb>
  let workerUtils: ReturnType<typeof makeMockWorkerUtils>
  let service: ApprovalService

  beforeEach(() => {
    db = makeMockDb()
    workerUtils = makeMockWorkerUtils()
    service = new ApprovalService({ db, workerUtils: workerUtils as never })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("createRequest", () => {
    it("creates an approval request and transitions job to WAITING_FOR_APPROVAL", async () => {
      db._txMockResult.executeTakeFirstOrThrow.mockResolvedValue({
        id: "approval-1",
      })

      const result = await service.createRequest({
        jobId: "job-1",
        agentId: "agent-1",
        actionType: "deploy_staging",
        actionSummary: "Deploy to staging",
        actionDetail: { image: "app:v2.4.1" },
      })

      expect(result.approvalRequestId).toBe("approval-1")
      expect(result.plaintextToken).toMatch(/^cortex_apr_1_/)
      expect(result.expiresAt).toBeInstanceOf(Date)
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it("respects custom TTL", async () => {
      db._txMockResult.executeTakeFirstOrThrow.mockResolvedValue({
        id: "approval-2",
      })

      const result = await service.createRequest({
        jobId: "job-1",
        agentId: "agent-1",
        actionType: "deploy_staging",
        actionSummary: "Deploy to staging",
        actionDetail: {},
        ttlSeconds: 3600, // 1 hour
      })

      const expectedExpiry = Date.now() + 3600 * 1000
      // Allow 5 second tolerance for test execution time
      expect(result.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000)
      expect(result.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000)
    })

    it("caps TTL at max", async () => {
      db._txMockResult.executeTakeFirstOrThrow.mockResolvedValue({
        id: "approval-3",
      })

      const result = await service.createRequest({
        jobId: "job-1",
        agentId: "agent-1",
        actionType: "deploy_staging",
        actionSummary: "Deploy",
        actionDetail: {},
        ttlSeconds: 999_999, // Way over max
      })

      // Should be capped at 604800 seconds (7 days)
      const maxExpiry = Date.now() + 604_800 * 1000
      expect(result.expiresAt.getTime()).toBeLessThan(maxExpiry + 5000)
    })
  })

  describe("decide", () => {
    const pendingRequest = {
      id: "approval-1",
      job_id: "job-1",
      status: "PENDING" as const,
      expires_at: new Date(Date.now() + 86_400_000), // 24h from now
      approver_user_account_id: null,
      token_hash: "test-hash",
      action_type: "deploy_staging",
      action_detail: {},
      requested_at: new Date(),
      decided_at: null,
      decided_by: null,
      decision_note: null,
      requested_by_agent_id: "agent-1",
      notification_channels: [],
      action_summary: "Deploy to staging",
    }

    it("returns not_found for missing request", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue(undefined)

      const result = await service.decide("nonexistent", "APPROVED", "user-1", "api")

      expect(result.success).toBe(false)
      expect(result.error).toBe("not_found")
    })

    it("returns already_decided for non-PENDING request", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue({
        ...pendingRequest,
        status: "APPROVED",
      })

      const result = await service.decide("approval-1", "APPROVED", "user-1", "api")

      expect(result.success).toBe(false)
      expect(result.error).toBe("already_decided")
    })

    it("returns expired for past-due request", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue({
        ...pendingRequest,
        expires_at: new Date(Date.now() - 1000), // Already expired
      })

      const result = await service.decide("approval-1", "APPROVED", "user-1", "api")

      expect(result.success).toBe(false)
      expect(result.error).toBe("expired")
    })

    it("returns not_authorized for wrong approver", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue({
        ...pendingRequest,
        approver_user_account_id: "specific-user",
      })

      const result = await service.decide("approval-1", "APPROVED", "wrong-user", "api")

      expect(result.success).toBe(false)
      expect(result.error).toBe("not_authorized")
    })

    it("approves request and enqueues agent resume", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue(pendingRequest)
      db._txMockResult.executeTakeFirst.mockResolvedValue({
        numUpdatedRows: 1n,
      })

      const result = await service.decide("approval-1", "APPROVED", "user-1", "telegram")

      expect(result.success).toBe(true)
      expect(result.decision).toBe("APPROVED")
      expect(workerUtils.addJob).toHaveBeenCalledWith(
        "agent_execute",
        { jobId: "job-1" },
        { maxAttempts: 1 },
      )
    })

    it("rejects request without enqueuing worker job", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue(pendingRequest)
      db._txMockResult.executeTakeFirst.mockResolvedValue({
        numUpdatedRows: 1n,
      })

      const result = await service.decide(
        "approval-1",
        "REJECTED",
        "user-1",
        "dashboard",
        "Not ready for staging",
      )

      expect(result.success).toBe(true)
      expect(result.decision).toBe("REJECTED")
      expect(workerUtils.addJob).not.toHaveBeenCalled()
    })

    it("allows designated approver to decide", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue({
        ...pendingRequest,
        approver_user_account_id: "user-1",
      })
      db._txMockResult.executeTakeFirst.mockResolvedValue({
        numUpdatedRows: 1n,
      })

      const result = await service.decide("approval-1", "APPROVED", "user-1", "api")

      expect(result.success).toBe(true)
    })
  })

  describe("decideByToken", () => {
    it("returns invalid_token_format for bad tokens", async () => {
      const result = await service.decideByToken("not_a_valid_token", "APPROVED", "user-1", "api")

      expect(result.success).toBe(false)
      expect(result.error).toBe("invalid_token_format")
    })

    it("returns not_found when hash not in database", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue(undefined)

      const result = await service.decideByToken(
        "cortex_apr_1_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdA",
        "APPROVED",
        "user-1",
        "api",
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("not_found")
    })
  })

  describe("expireStaleRequests", () => {
    it("expires pending requests past their deadline", async () => {
      const expiredReqs = [
        { id: "approval-1", job_id: "job-1" },
        { id: "approval-2", job_id: "job-2" },
      ]
      db._mockResult.execute.mockResolvedValue(expiredReqs)
      db._txMockResult.executeTakeFirst.mockResolvedValue({
        numUpdatedRows: 1n,
      })

      const count = await service.expireStaleRequests()

      expect(count).toBe(2)
    })

    it("returns 0 when no expired requests", async () => {
      db._mockResult.execute.mockResolvedValue([])

      const count = await service.expireStaleRequests()

      expect(count).toBe(0)
    })
  })

  describe("list", () => {
    it("lists approval requests with default options", async () => {
      const requests = [
        { id: "approval-1", status: "PENDING" },
        { id: "approval-2", status: "APPROVED" },
      ]
      db._mockResult.execute.mockResolvedValue(requests)

      const result = await service.list()

      expect(result).toEqual(requests)
    })

    it("filters by status", async () => {
      db._mockResult.execute.mockResolvedValue([])

      await service.list({ status: "PENDING" })

      // Verify the chain was called (the where mock returns this)
      expect(db.selectFrom).toHaveBeenCalledWith("approval_request")
    })
  })

  describe("getRequest", () => {
    it("returns a single request by ID", async () => {
      const request = { id: "approval-1", status: "PENDING" }
      db._mockResult.executeTakeFirst.mockResolvedValue(request)

      const result = await service.getRequest("approval-1")

      expect(result).toEqual(request)
    })

    it("returns undefined for missing request", async () => {
      db._mockResult.executeTakeFirst.mockResolvedValue(undefined)

      const result = await service.getRequest("nonexistent")

      expect(result).toBeUndefined()
    })
  })
})
