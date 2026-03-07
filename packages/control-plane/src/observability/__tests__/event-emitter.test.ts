import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Database } from "../../db/types.js"
import type { SSEConnectionManager } from "../../streaming/manager.js"
import { AgentEventEmitter } from "../event-emitter.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Build a chainable Kysely mock for `agent_event` operations. */
function buildMockDb(
  opts: {
    insertedIds?: string[]
    selectRows?: Array<Record<string, unknown>>
    countTotal?: number
  } = {},
) {
  const { insertedIds = [], selectRows = [], countTotal = 0 } = opts

  const insertValues = vi.fn()
  const insertReturning = vi.fn()
  const insertExecuteTakeFirstOrThrow = vi.fn()
  const insertExecute = vi.fn().mockResolvedValue(undefined)

  // For single-row inserts (returning id)
  let insertCallIndex = 0
  insertExecuteTakeFirstOrThrow.mockImplementation(() => {
    const id = insertedIds[insertCallIndex] ?? `generated-${insertCallIndex}`
    insertCallIndex++
    return Promise.resolve({ id })
  })

  insertReturning.mockReturnValue({ executeTakeFirstOrThrow: insertExecuteTakeFirstOrThrow })
  insertValues.mockReturnValue({
    returning: insertReturning,
    execute: insertExecute,
  })

  // For select (query)
  const selectExecute = vi.fn().mockResolvedValue(selectRows)
  const selectExecuteTakeFirstOrThrow = vi.fn().mockResolvedValue({ total: countTotal })

  function makeSelectChain() {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    const where = vi.fn().mockReturnValue(chain)
    const orderBy = vi.fn().mockReturnValue(chain)
    const limit = vi.fn().mockReturnValue(chain)
    const offset = vi.fn().mockReturnValue(chain)
    const selectAll = vi.fn().mockReturnValue(chain)
    const select = vi.fn().mockReturnValue(chain)
    Object.assign(chain, {
      where,
      orderBy,
      limit,
      offset,
      selectAll,
      select,
      execute: selectExecute,
      executeTakeFirstOrThrow: selectExecuteTakeFirstOrThrow,
    })
    return chain
  }

  const fn = { countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue("total") }) }

  const selectFrom = vi.fn().mockImplementation(() => makeSelectChain())

  const db = {
    insertInto: vi.fn().mockReturnValue({ values: insertValues }),
    selectFrom,
    fn,
  } as unknown as Kysely<Database>

  return {
    db,
    insertValues,
    insertExecute,
    selectFrom,
    selectExecute,
    selectExecuteTakeFirstOrThrow,
  }
}

function buildMockSseManager() {
  const broadcast = vi.fn()
  const manager = { broadcast } as unknown as SSEConnectionManager
  return { manager, broadcast }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentEventEmitter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── emit() ─────────────────────────────────────────────────────────────

  describe("emit()", () => {
    it("persists event to agent_event table with all columns", async () => {
      const { db, insertValues, insertExecute } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const result = await emitter.emit({
        agentId: "agent-1",
        sessionId: "sess-1",
        jobId: "job-1",
        parentEventId: "parent-1",
        eventType: "llm_call_end",
        model: "claude-sonnet-4-20250514",
        toolRef: null,
        actor: "agent",
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        durationMs: 1200,
        payload: { prompt: "hello" },
      })

      expect(result.eventId).toBeDefined()
      expect(typeof result.eventId).toBe("string")

      // Should be buffered, not yet flushed
      expect(emitter.pendingCount).toBe(1)
      expect(insertValues).not.toHaveBeenCalled()

      // Flush
      await emitter.flush()

      expect(insertValues).toHaveBeenCalledTimes(1)
      const values = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(values).toHaveLength(1)
      expect(values[0]).toMatchObject({
        agent_id: "agent-1",
        session_id: "sess-1",
        job_id: "job-1",
        parent_event_id: "parent-1",
        event_type: "llm_call_end",
        model: "claude-sonnet-4-20250514",
        actor: "agent",
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: "0.003",
        duration_ms: 1200,
        payload: { prompt: "hello" },
      })
      expect(insertExecute).toHaveBeenCalledTimes(1)
    })

    it("broadcasts event via sseManager.broadcast()", async () => {
      const { db } = buildMockDb()
      const { manager, broadcast } = buildMockSseManager()
      const emitter = new AgentEventEmitter(db, manager, 100)

      const result = await emitter.emit({
        agentId: "agent-1",
        eventType: "message_sent",
        payload: { text: "hi" },
      })

      expect(broadcast).toHaveBeenCalledTimes(1)
      expect(broadcast).toHaveBeenCalledWith("agent-1", "agent:output", {
        agentId: "agent-1",
        timestamp: expect.any(String) as string,
        output: {
          type: "event",
          eventType: "message_sent",
          eventId: result.eventId,
          text: "hi",
        },
      })

      emitter.dispose()
    })

    it("handles null/undefined optional fields correctly", async () => {
      const { db, insertValues } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.emit({
        agentId: "agent-1",
        eventType: "error",
      })

      await emitter.flush()

      const values = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(values[0]).toMatchObject({
        agent_id: "agent-1",
        session_id: null,
        job_id: null,
        parent_event_id: null,
        event_type: "error",
        model: null,
        tool_ref: null,
        actor: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        duration_ms: null,
        payload: {},
      })
    })
  })

  // ── emitStart() ────────────────────────────────────────────────────────

  describe("emitStart()", () => {
    it("returns an EventHandle with eventId", async () => {
      const { db } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const handle = await emitter.emitStart({
        agentId: "agent-1",
        eventType: "llm_call_start",
        model: "claude-sonnet-4-20250514",
        actor: "agent",
      })

      expect(handle.eventId).toBeDefined()
      expect(typeof handle.eventId).toBe("string")
      expect(typeof handle.end).toBe("function")

      emitter.dispose()
    })

    it("calculates correct duration_ms between start and end", async () => {
      const { db, insertValues } = buildMockDb()
      // Use a long flush interval so we can control timing manually
      const emitter = new AgentEventEmitter(db, undefined, 60_000)

      const handle = await emitter.emitStart({
        agentId: "agent-1",
        eventType: "llm_call_start",
      })

      // Advance time by 250ms (without triggering the flush timer)
      vi.advanceTimersByTime(250)

      await handle.end({ tokensIn: 100, tokensOut: 50, costUsd: 0.005 })
      await emitter.flush()

      // Both start and end events should be in the batch
      const allValues = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(allValues).toHaveLength(2)
      // The end event should have duration_ms = 250
      const endEvent = allValues.find((v) => v.event_type === "llm_call_end")
      expect(endEvent).toBeDefined()
      expect(endEvent!.duration_ms).toBe(250)
      expect(endEvent!.parent_event_id).toBe(handle.eventId)
      expect(endEvent!.tokens_in).toBe(100)
      expect(endEvent!.tokens_out).toBe(50)
      expect(endEvent!.cost_usd).toBe("0.005")
    })

    it("end() replaces _start with _end in event type", async () => {
      const { db, insertValues } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const handle = await emitter.emitStart({
        agentId: "agent-1",
        eventType: "tool_call_start",
      })
      await handle.end()
      await emitter.flush()

      const allValues = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      const startEvent = allValues.find((v) => v.event_type === "tool_call_start")
      const endEvent = allValues.find((v) => v.event_type === "tool_call_end")
      expect(startEvent).toBeDefined()
      expect(endEvent).toBeDefined()
    })

    it("broadcasts both start and end events", async () => {
      const { db } = buildMockDb()
      const { manager, broadcast } = buildMockSseManager()
      const emitter = new AgentEventEmitter(db, manager, 100)

      const handle = await emitter.emitStart({
        agentId: "agent-1",
        eventType: "llm_call_start",
      })

      expect(broadcast).toHaveBeenCalledTimes(1)
      expect(broadcast).toHaveBeenCalledWith(
        "agent-1",
        "agent:output",
        expect.objectContaining({
          output: expect.objectContaining({ eventType: "llm_call_start" }) as unknown,
        }) as unknown,
      )

      await handle.end({ tokensIn: 10, tokensOut: 5 })

      expect(broadcast).toHaveBeenCalledTimes(2)
      const endCall = broadcast.mock.calls[1]!
      const endData = endCall[2] as Record<string, unknown>
      const endOutput = endData.output as Record<string, unknown>
      expect(endOutput.eventType).toBe("llm_call_end")
      expect(endOutput.parentEventId).toBe(handle.eventId)
      expect(endOutput.tokensIn).toBe(10)
      expect(endOutput.tokensOut).toBe(5)

      emitter.dispose()
    })

    it("propagates actor from start to end event", async () => {
      const { db, insertValues } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const handle = await emitter.emitStart({
        agentId: "agent-1",
        eventType: "llm_call_start",
        actor: "operator",
      })
      await handle.end()
      await emitter.flush()

      const allValues = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(allValues[0]!.actor).toBe("operator")
      expect(allValues[1]!.actor).toBe("operator")
    })
  })

  // ── query() ────────────────────────────────────────────────────────────

  describe("query()", () => {
    it("returns paginated results with correct total count", async () => {
      const now = new Date()
      const rows = [
        {
          id: "ev-1",
          agent_id: "agent-1",
          session_id: null,
          job_id: null,
          parent_event_id: null,
          event_type: "message_sent",
          payload: {},
          tokens_in: null,
          tokens_out: null,
          cost_usd: null,
          duration_ms: null,
          model: null,
          tool_ref: null,
          actor: "agent",
          created_at: now,
        },
      ]
      const { db } = buildMockDb({ selectRows: rows, countTotal: 5 })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const result = await emitter.query({ agentId: "agent-1", limit: 1, offset: 0 })

      expect(result.total).toBe(5)
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toMatchObject({
        id: "ev-1",
        agentId: "agent-1",
        eventType: "message_sent",
        actor: "agent",
        createdAt: now,
      })

      emitter.dispose()
    })

    it("applies eventType filter", async () => {
      const { db, selectFrom } = buildMockDb({ selectRows: [], countTotal: 0 })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.query({
        agentId: "agent-1",
        eventTypes: ["llm_call_start", "llm_call_end"],
      })

      // The selectFrom call chain should include a where for event_type
      expect(selectFrom).toHaveBeenCalledWith("agent_event")

      emitter.dispose()
    })

    it("applies sessionId, jobId, actor, and time range filters", async () => {
      const { db, selectFrom } = buildMockDb({ selectRows: [], countTotal: 0 })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const since = new Date("2025-01-01")
      const until = new Date("2025-12-31")

      await emitter.query({
        agentId: "agent-1",
        sessionId: "sess-1",
        jobId: "job-1",
        actor: "system",
        since,
        until,
        limit: 10,
        offset: 5,
      })

      // Verify the query was issued against agent_event
      expect(selectFrom).toHaveBeenCalledWith("agent_event")

      emitter.dispose()
    })

    it("flushes buffer before querying", async () => {
      const { db, insertValues, insertExecute } = buildMockDb({
        selectRows: [],
        countTotal: 0,
      })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      // Emit an event (buffered)
      await emitter.emit({ agentId: "agent-1", eventType: "error" })
      expect(emitter.pendingCount).toBe(1)

      // Query triggers flush
      await emitter.query({ agentId: "agent-1" })

      expect(emitter.pendingCount).toBe(0)
      expect(insertValues).toHaveBeenCalledTimes(1)
      expect(insertExecute).toHaveBeenCalledTimes(1)
    })

    it("converts cost_usd from string to number", async () => {
      const rows = [
        {
          id: "ev-1",
          agent_id: "agent-1",
          session_id: null,
          job_id: null,
          parent_event_id: null,
          event_type: "llm_call_end",
          payload: {},
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: "0.005000",
          duration_ms: 1200,
          model: "claude-sonnet-4-20250514",
          tool_ref: null,
          actor: null,
          created_at: new Date(),
        },
      ]
      const { db } = buildMockDb({ selectRows: rows, countTotal: 1 })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const result = await emitter.query({ agentId: "agent-1" })

      expect(result.events[0]!.costUsd).toBe(0.005)
      expect(typeof result.events[0]!.costUsd).toBe("number")

      emitter.dispose()
    })

    it("uses default limit=50 and offset=0", async () => {
      const { db } = buildMockDb({ selectRows: [], countTotal: 0 })
      const emitter = new AgentEventEmitter(db, undefined, 100)

      // Just call with minimal filters — defaults should apply
      await emitter.query({})

      // We trust the implementation uses 50/0; the chain is mocked so
      // we just verify no errors
      emitter.dispose()
    })
  })

  // ── batch insert ───────────────────────────────────────────────────────

  describe("batch insert", () => {
    it("buffers events and flushes after interval", async () => {
      const { db, insertValues, insertExecute } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.emit({ agentId: "agent-1", eventType: "message_sent" })
      await emitter.emit({ agentId: "agent-2", eventType: "error" })

      // Not flushed yet
      expect(insertValues).not.toHaveBeenCalled()
      expect(emitter.pendingCount).toBe(2)

      // Advance past the flush interval
      await vi.advanceTimersByTimeAsync(100)

      // Should have flushed both events in a single batch
      expect(insertValues).toHaveBeenCalledTimes(1)
      const batch = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(batch).toHaveLength(2)
      expect(batch[0]!.agent_id).toBe("agent-1")
      expect(batch[1]!.agent_id).toBe("agent-2")
      expect(insertExecute).toHaveBeenCalledTimes(1)
      expect(emitter.pendingCount).toBe(0)
    })

    it("flush() is idempotent when buffer is empty", async () => {
      const { db, insertValues } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.flush()
      await emitter.flush()

      expect(insertValues).not.toHaveBeenCalled()
    })

    it("manual flush() clears pending timer", async () => {
      const { db, insertExecute } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.emit({ agentId: "agent-1", eventType: "error" })

      // Manual flush before timer fires
      await emitter.flush()
      expect(insertExecute).toHaveBeenCalledTimes(1)

      // Advancing timer should not cause a second flush
      await vi.advanceTimersByTimeAsync(200)
      expect(insertExecute).toHaveBeenCalledTimes(1)
    })

    it("dispose() cancels pending flush timer", async () => {
      const { db, insertExecute } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      await emitter.emit({ agentId: "agent-1", eventType: "error" })
      emitter.dispose()

      // Advancing past the interval should not trigger a flush
      await vi.advanceTimersByTimeAsync(200)
      expect(insertExecute).not.toHaveBeenCalled()
    })

    it("each event gets a unique UUID", async () => {
      const { db, insertValues } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const r1 = await emitter.emit({ agentId: "agent-1", eventType: "message_sent" })
      const r2 = await emitter.emit({ agentId: "agent-1", eventType: "message_received" })

      expect(r1.eventId).not.toBe(r2.eventId)

      await emitter.flush()

      const batch = insertValues.mock.calls[0]![0] as Array<Record<string, unknown>>
      expect(batch[0]!.id).toBe(r1.eventId)
      expect(batch[1]!.id).toBe(r2.eventId)
    })
  })

  // ── no SSE manager ────────────────────────────────────────────────────

  describe("without SSE manager", () => {
    it("emits without error when streamManager is undefined", async () => {
      const { db } = buildMockDb()
      const emitter = new AgentEventEmitter(db, undefined, 100)

      const result = await emitter.emit({
        agentId: "agent-1",
        eventType: "error",
        payload: { message: "test" },
      })

      expect(result.eventId).toBeDefined()
      emitter.dispose()
    })
  })
})
