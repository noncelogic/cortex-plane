/**
 * AgentEventEmitter — persists structured agent events to the `agent_event`
 * table and optionally broadcasts them over SSE.
 *
 * Each `emitStart()` call inserts a start event and returns an `EventHandle`
 * whose `end()` method inserts the corresponding end event with duration,
 * token counts, and cost.
 */

import type { Kysely } from "kysely"

import type { Database, NewAgentEvent } from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

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
// Implementation
// ---------------------------------------------------------------------------

export class AgentEventEmitter {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly streamManager?: SSEConnectionManager,
  ) {}

  /**
   * Emit a start event (e.g. `llm_call_start`, `tool_call_start`).
   * Returns an `EventHandle` whose `end()` inserts the matching end event.
   */
  async emitStart(params: EventStartParams): Promise<EventHandle> {
    const startedAt = Date.now()
    const eventId = await this.persist({
      agent_id: params.agentId,
      session_id: params.sessionId ?? null,
      job_id: params.jobId ?? null,
      event_type: params.eventType,
      model: params.model ?? null,
      tool_ref: params.toolRef ?? null,
      payload: params.payload ?? {},
    })

    this.broadcast(params.agentId, params.eventType, {
      eventId,
      ...params.payload,
    })

    return {
      eventId,
      end: async (endParams?: EventEndParams): Promise<string> => {
        const durationMs = Date.now() - startedAt
        const endType = params.eventType.replace(/_start$/, "_end")
        const endEventId = await this.persist({
          agent_id: params.agentId,
          session_id: params.sessionId ?? null,
          job_id: params.jobId ?? null,
          parent_event_id: eventId,
          event_type: endType,
          model: params.model ?? null,
          tool_ref: params.toolRef ?? null,
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

        return endEventId
      },
    }
  }

  /**
   * Emit a standalone event (no start/end pair).
   */
  async emit(params: EventStartParams & EventEndParams): Promise<string> {
    const eventId = await this.persist({
      agent_id: params.agentId,
      session_id: params.sessionId ?? null,
      job_id: params.jobId ?? null,
      event_type: params.eventType,
      model: params.model ?? null,
      tool_ref: params.toolRef ?? null,
      tokens_in: params.tokensIn ?? null,
      tokens_out: params.tokensOut ?? null,
      cost_usd: params.costUsd != null ? String(params.costUsd) : null,
      payload: params.payload ?? {},
    })

    this.broadcast(params.agentId, params.eventType, {
      eventId,
      ...params.payload,
    })

    return eventId
  }

  // ── Private helpers ──

  private async persist(event: NewAgentEvent): Promise<string> {
    const row = await this.db
      .insertInto("agent_event")
      .values(event)
      .returning("id")
      .executeTakeFirstOrThrow()
    return row.id
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
