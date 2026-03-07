/**
 * AgentEventEmitter — persists structured agent events to the `agent_event`
 * table and optionally broadcasts them over SSE.
 *
 * Each `emitStart()` call inserts a start event and returns an `EventHandle`
 * whose `end()` method inserts the corresponding end event with duration,
 * token counts, and cost.
 *
 * High-throughput optimisation: events are buffered and flushed in batches
 * (default: every 100 ms) to reduce INSERT round-trips.
 */

import { randomUUID } from "node:crypto"

import type { Kysely } from "kysely"

import type { Database, NewAgentEvent } from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"
import type {
  AgentEventInput,
  AgentEventRow,
  EventQueryFilters,
  EventQueryResult,
} from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventStartParams {
  eventType: string
  agentId: string
  sessionId?: string | null
  jobId?: string | null
  model?: string | null
  toolRef?: string | null
  actor?: string | null
  payload?: Record<string, unknown>
}

export interface EventEndParams {
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  payload?: Record<string, unknown>
}

export interface EventHandle {
  /** The persisted event ID of the start event. */
  eventId: string
  /** Finalize the event pair — inserts the corresponding `*_end` event. */
  end(params?: EventEndParams): Promise<string>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 100

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AgentEventEmitter {
  private readonly buffer: Array<NewAgentEvent & { id: string }> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly flushIntervalMs: number

  constructor(
    private readonly db: Kysely<Database>,
    private readonly streamManager?: SSEConnectionManager,
    flushIntervalMs?: number,
  ) {
    this.flushIntervalMs = flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  }

  // ── emit / emitStart ───────────────────────────────────────────────────

  /**
   * Emit a standalone event (no start/end pair).
   * The event is returned with `{ eventId }` immediately; the actual DB write
   * is batched.
   */
  emit(params: AgentEventInput): Promise<{ eventId: string }> {
    const eventId = this.enqueue({
      agent_id: params.agentId,
      session_id: params.sessionId ?? null,
      job_id: params.jobId ?? null,
      parent_event_id: params.parentEventId ?? null,
      event_type: params.eventType,
      model: params.model ?? null,
      tool_ref: params.toolRef ?? null,
      actor: params.actor ?? null,
      tokens_in: params.tokensIn ?? null,
      tokens_out: params.tokensOut ?? null,
      cost_usd: params.costUsd != null ? String(params.costUsd) : null,
      duration_ms: params.durationMs ?? null,
      payload: params.payload ?? {},
    })

    this.broadcast(params.agentId, params.eventType, {
      eventId,
      ...params.payload,
    })

    return Promise.resolve({ eventId })
  }

  /**
   * Emit a start event (e.g. `llm_call_start`, `tool_call_start`).
   * Returns an `EventHandle` whose `end()` inserts the matching end event.
   */
  emitStart(params: EventStartParams): Promise<EventHandle> {
    const startedAt = Date.now()
    const eventId = this.enqueue({
      agent_id: params.agentId,
      session_id: params.sessionId ?? null,
      job_id: params.jobId ?? null,
      event_type: params.eventType,
      model: params.model ?? null,
      tool_ref: params.toolRef ?? null,
      actor: params.actor ?? null,
      payload: params.payload ?? {},
    })

    this.broadcast(params.agentId, params.eventType, {
      eventId,
      ...params.payload,
    })

    return Promise.resolve({
      eventId,
      end: (endParams?: EventEndParams): Promise<string> => {
        const durationMs = Date.now() - startedAt
        const endType = params.eventType.replace(/_start$/, "_end")
        const endEventId = this.enqueue({
          agent_id: params.agentId,
          session_id: params.sessionId ?? null,
          job_id: params.jobId ?? null,
          parent_event_id: eventId,
          event_type: endType,
          model: params.model ?? null,
          tool_ref: params.toolRef ?? null,
          actor: params.actor ?? null,
          tokens_in: endParams?.tokensIn ?? null,
          tokens_out: endParams?.tokensOut ?? null,
          cost_usd: endParams?.costUsd != null ? String(endParams.costUsd) : null,
          duration_ms: durationMs,
          payload: endParams?.payload ?? {},
        })

        this.broadcast(params.agentId, endType, {
          eventId: endEventId,
          parentEventId: eventId,
          durationMs,
          tokensIn: endParams?.tokensIn,
          tokensOut: endParams?.tokensOut,
          costUsd: endParams?.costUsd,
          ...endParams?.payload,
        })

        return Promise.resolve(endEventId)
      },
    })
  }

  // ── query ──────────────────────────────────────────────────────────────

  /**
   * Paginated query against `agent_event` with optional filters.
   */
  async query(filters: EventQueryFilters): Promise<EventQueryResult> {
    // Flush any pending buffered events so the query sees them.
    await this.flush()

    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    let base = this.db.selectFrom("agent_event")

    if (filters.agentId) {
      base = base.where("agent_id", "=", filters.agentId)
    }
    if (filters.sessionId) {
      base = base.where("session_id", "=", filters.sessionId)
    }
    if (filters.jobId) {
      base = base.where("job_id", "=", filters.jobId)
    }
    if (filters.eventTypes && filters.eventTypes.length > 0) {
      base = base.where("event_type", "in", filters.eventTypes)
    }
    if (filters.actor) {
      base = base.where("actor", "=", filters.actor)
    }
    if (filters.since) {
      base = base.where("created_at", ">=", filters.since)
    }
    if (filters.until) {
      base = base.where("created_at", "<=", filters.until)
    }

    const [rows, countRow] = await Promise.all([
      base.selectAll().orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
      base.select(this.db.fn.countAll<number>().as("total")).executeTakeFirstOrThrow(),
    ])

    const events: AgentEventRow[] = rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      sessionId: r.session_id,
      jobId: r.job_id,
      parentEventId: r.parent_event_id,
      eventType: r.event_type,
      payload: r.payload,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      costUsd: r.cost_usd != null ? Number(r.cost_usd) : null,
      durationMs: r.duration_ms,
      model: r.model,
      toolRef: r.tool_ref,
      actor: r.actor,
      createdAt: r.created_at,
    }))

    return { events, total: Number(countRow.total) }
  }

  // ── batch insert ───────────────────────────────────────────────────────

  /**
   * Flush all buffered events to the database immediately.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return

    const batch = this.buffer.splice(0)
    await this.db.insertInto("agent_event").values(batch).execute()
  }

  /**
   * Cancel any pending flush timer. Call this on shutdown.
   */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** Number of events currently buffered (for testing). */
  get pendingCount(): number {
    return this.buffer.length
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Add an event to the write buffer and schedule a flush if needed.
   * Returns the pre-generated UUID so callers get an ID immediately.
   */
  private enqueue(event: NewAgentEvent): string {
    const id = randomUUID()
    this.buffer.push({ ...event, id })
    this.scheduleFlush()
    return id
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      void this.flush()
    }, this.flushIntervalMs)
  }

  private broadcast(agentId: string, eventType: string, data: Record<string, unknown>): void {
    if (!this.streamManager) return
    this.streamManager.broadcast(agentId, "agent:output", {
      agentId,
      timestamp: new Date().toISOString(),
      output: { type: "event", eventType, ...data },
    })
  }
}
