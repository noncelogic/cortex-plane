import type { JobHelpers } from "graphile-worker"
import type { Kysely } from "kysely"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../db/types.js"
import { createPruneAgentEventsTask } from "../worker/tasks/prune-agent-events.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHelpers() {
  return {
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as JobHelpers
}

/**
 * Build a mock Kysely instance that intercepts deleteFrom("agent_event") chains.
 *
 * Returns the number of deleted rows configured by each category.
 */
function buildMockDb(opts: { defaultDeleted?: bigint; costDeleted?: bigint } = {}) {
  const { defaultDeleted = 0n, costDeleted = 0n } = opts

  let deleteCallIndex = 0
  const deletedCounts = [defaultDeleted, costDeleted]

  // Reusable subquery mock (returned by selectFrom)
  function makeSubquery() {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockReturnValue(chain)
    return chain
  }

  const deleteFromFn = vi.fn().mockImplementation(() => {
    const idx = deleteCallIndex++
    const numDeletedRows = deletedCounts[idx] ?? 0n

    return {
      where: vi.fn().mockReturnValue({
        executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows }),
      }),
    }
  })

  const db = {
    deleteFrom: deleteFromFn,
    selectFrom: vi.fn().mockImplementation(() => makeSubquery()),
  } as unknown as Kysely<Database>

  return { db, deleteFromFn }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPruneAgentEventsTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-03-07T03:00:00Z"))
  })

  it("deletes non-cost events older than 30 days and cost events older than 90 days", async () => {
    const { db, deleteFromFn } = buildMockDb({ defaultDeleted: 5n, costDeleted: 2n })
    const task = createPruneAgentEventsTask(db)
    const helpers = makeHelpers()

    await task({}, helpers)

    expect(deleteFromFn).toHaveBeenCalledTimes(2)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).toHaveBeenCalledWith("prune_agent_events: deleted 7 events (5 default, 2 cost)")
  })

  it("does not log when no rows are pruned", async () => {
    const { db } = buildMockDb({ defaultDeleted: 0n, costDeleted: 0n })
    const task = createPruneAgentEventsTask(db)
    const helpers = makeHelpers()

    await task({}, helpers)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).not.toHaveBeenCalled()
  })

  it("respects custom retention config", async () => {
    const { db, deleteFromFn } = buildMockDb({ defaultDeleted: 10n, costDeleted: 3n })
    const task = createPruneAgentEventsTask(db, {
      defaultDays: 7,
      costEventDays: 60,
      batchSize: 500,
    })
    const helpers = makeHelpers()

    await task({}, helpers)

    expect(deleteFromFn).toHaveBeenCalledTimes(2)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).toHaveBeenCalledWith("prune_agent_events: deleted 13 events (10 default, 3 cost)")
  })

  it("is idempotent — safe to run when no matching rows exist", async () => {
    const { db } = buildMockDb()
    const task = createPruneAgentEventsTask(db)
    const helpers = makeHelpers()

    // Run twice
    await task({}, helpers)
    await expect(task({}, helpers)).resolves.toBeUndefined()
  })

  it("logs only cost pruned when no default events match", async () => {
    const { db } = buildMockDb({ defaultDeleted: 0n, costDeleted: 4n })
    const task = createPruneAgentEventsTask(db)
    const helpers = makeHelpers()

    await task({}, helpers)

    const { info } = helpers.logger as { info: ReturnType<typeof vi.fn> }
    expect(info).toHaveBeenCalledWith("prune_agent_events: deleted 4 events (0 default, 4 cost)")
  })
})
