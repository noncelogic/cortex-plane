import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Kysely } from "kysely"
import type { Database } from "../db/types.js"
import { FeedbackService } from "../feedback/service.js"

function makeMockDb() {
  const mockResult = {
    executeTakeFirst: vi.fn(),
    executeTakeFirstOrThrow: vi.fn(),
    execute: vi.fn(),
  }

  const mockChain = {
    select: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirst: mockResult.executeTakeFirst,
    executeTakeFirstOrThrow: mockResult.executeTakeFirstOrThrow,
    execute: mockResult.execute,
  }

  return {
    selectFrom: vi.fn().mockReturnValue(mockChain),
    insertInto: vi.fn().mockReturnValue(mockChain),
    updateTable: vi.fn().mockReturnValue(mockChain),
    _mockResult: mockResult,
  } as unknown as Kysely<Database> & { _mockResult: typeof mockResult }
}

describe("FeedbackService", () => {
  let db: ReturnType<typeof makeMockDb>
  let service: FeedbackService

  beforeEach(() => {
    db = makeMockDb()
    service = new FeedbackService({ db })
  })

  it("creates feedback", async () => {
    db._mockResult.executeTakeFirst.mockResolvedValue(undefined)
    db._mockResult.executeTakeFirstOrThrow.mockResolvedValue({ id: "fb-1", severity: "low" })

    const item = await service.createFeedback({
      source: "user_correction",
      category: "accuracy",
      severity: "low",
      summary: "Wrong detail",
    })

    expect(item.id).toBe("fb-1")
  })

  it("escalates severity on recurrence", async () => {
    db._mockResult.executeTakeFirst.mockResolvedValueOnce({ severity: "medium" })
    db._mockResult.executeTakeFirstOrThrow.mockResolvedValueOnce({ id: "fb-2", severity: "high" })

    const item = await service.createFeedback({
      source: "automated",
      category: "behavior",
      severity: "low",
      summary: "Repeated issue",
      recurrenceKey: "same-pattern",
    })

    expect(item.severity).toBe("high")
  })

  it("lists and updates feedback", async () => {
    db._mockResult.execute.mockResolvedValue([{ id: "fb-1" }])
    const list = await service.listFeedback()
    expect(list).toHaveLength(1)

    db._mockResult.executeTakeFirst.mockResolvedValue({ id: "fb-1", remediation_status: "planned" })
    const updated = await service.updateRemediation("fb-1", { remediationStatus: "planned" })
    expect(updated?.id).toBe("fb-1")
  })

  it("adds and fetches actions", async () => {
    db._mockResult.executeTakeFirstOrThrow.mockResolvedValue({ id: 1, feedback_id: "fb-1" })
    const action = await service.addAction({ feedbackId: "fb-1", actionType: "code_fix" })
    expect(action.id).toBe(1)

    db._mockResult.execute.mockResolvedValue([{ id: 1 }, { id: 2 }])
    const actions = await service.getActions("fb-1")
    expect(actions).toHaveLength(2)
  })
})
