import { describe, expect, it, vi } from "vitest"

import {
  createPruneAgentEventsTask,
  type EventRetentionConfig,
  type PruneResult,
  runPruneAgentEvents,
} from "../prune-agent-events.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

/**
 * Build a mock Kysely db that tracks delete queries.
 * Returns the mock and arrays capturing the WHERE predicates.
 */
function mockDb(generalDeleted = 0n, costDeleted = 0n) {
  let callCount = 0

  const executeTakeFirst = vi.fn().mockImplementation(() => {
    callCount++
    // First call is general events, second is cost events
    return Promise.resolve({
      numDeletedRows: callCount === 1 ? generalDeleted : costDeleted,
    })
  })

  const limitFn = vi.fn().mockReturnThis()

  const innerWhere = vi.fn().mockImplementation(function (this: unknown) {
    return { limit: limitFn, where: innerWhere, select: vi.fn().mockReturnThis() }
  })

  const innerSelect = vi.fn().mockImplementation(() => ({
    where: innerWhere,
    limit: limitFn,
  }))

  const innerSelectFrom = vi.fn().mockImplementation(() => ({
    select: innerSelect,
  }))

  const outerWhere = vi.fn().mockImplementation((_col: string, _op: string, subquery: unknown) => {
    // The subquery is a callback — invoke it with our mock query builder
    if (typeof subquery === "function") {
      subquery({ selectFrom: innerSelectFrom })
    }
    return { executeTakeFirst }
  })

  const deleteFrom = vi.fn().mockImplementation(() => ({
    where: outerWhere,
  }))

  return {
    db: { deleteFrom } as unknown as Parameters<typeof runPruneAgentEvents>[0],
    deleteFrom,
    executeTakeFirst,
  }
}

function mockHelpers() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    addJob: vi.fn(),
    job: { id: "job-1" },
    withPgClient: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof createPruneAgentEventsTask>>[1]
}

// ──────────────────────────────────────────────────
// runPruneAgentEvents
// ──────────────────────────────────────────────────

describe("runPruneAgentEvents", () => {
  it("deletes general events and cost events separately", async () => {
    const { db } = mockDb(5n, 3n)

    const result = await runPruneAgentEvents(db)

    expect(result.generalPruned).toBe(5)
    expect(result.costPruned).toBe(3)
  })

  it("returns zero counts when nothing to prune", async () => {
    const { db } = mockDb(0n, 0n)

    const result = await runPruneAgentEvents(db)

    expect(result.generalPruned).toBe(0)
    expect(result.costPruned).toBe(0)
  })

  it("issues two deleteFrom calls (general + cost)", async () => {
    const { db, deleteFrom } = mockDb(0n, 0n)

    await runPruneAgentEvents(db)

    expect(deleteFrom).toHaveBeenCalledTimes(2)
    expect(deleteFrom).toHaveBeenCalledWith("agent_event")
  })

  it("respects custom config values", async () => {
    const { db } = mockDb(10n, 2n)
    const config: EventRetentionConfig = {
      defaultDays: 7,
      costEventDays: 14,
      batchSize: 500,
    }

    const result = await runPruneAgentEvents(db, config)

    expect(result.generalPruned).toBe(10)
    expect(result.costPruned).toBe(2)
  })

  it("uses default config when none provided", async () => {
    const { db } = mockDb(1n, 0n)

    // Should not throw — defaults are applied internally
    const result = await runPruneAgentEvents(db)

    expect(result.generalPruned).toBe(1)
    expect(result.costPruned).toBe(0)
  })
})

// ──────────────────────────────────────────────────
// createPruneAgentEventsTask
// ──────────────────────────────────────────────────

describe("createPruneAgentEventsTask", () => {
  it("logs pruned count when events are deleted", async () => {
    const { db } = mockDb(10n, 5n)
    const task = createPruneAgentEventsTask(db)
    const helpers = mockHelpers()

    await task({}, helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("pruned 15 event(s)"))
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("general=10"))
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("cost=5"))
  })

  it("logs no-op message when nothing pruned", async () => {
    const { db } = mockDb(0n, 0n)
    const task = createPruneAgentEventsTask(db)
    const helpers = mockHelpers()

    await task({}, helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("no events to prune"))
  })

  it("passes config through to pipeline", async () => {
    const { db } = mockDb(3n, 1n)
    const config: EventRetentionConfig = { defaultDays: 7, costEventDays: 14, batchSize: 100 }
    const task = createPruneAgentEventsTask(db, config)
    const helpers = mockHelpers()

    await task({}, helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("pruned 4 event(s)"))
  })

  it("is idempotent — safe to call multiple times", async () => {
    const { db } = mockDb(2n, 0n)
    const task = createPruneAgentEventsTask(db)
    const helpers = mockHelpers()

    // Run twice — should not throw or produce errors
    await task({}, helpers)
    await task({}, helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.error).not.toHaveBeenCalled()
  })
})
