/**
 * Operator Event Routes
 *
 * GET  /operators/activity-stream       — SSE activity stream (all agents)
 * GET  /agents/:agentId/events          — paginated event query
 * GET  /agents/:agentId/cost            — cost aggregation by model/session/day
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"
import { sql } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentParams {
  agentId: string
}

interface ActivityStreamQuery {
  agentIds?: string
  eventTypes?: string
  since?: string
}

interface EventListQuery {
  eventTypes?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

interface CostQuery {
  since?: string
  until?: string
  groupBy?: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface OperatorEventRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sseManager: SSEConnectionManager
  sessionService?: SessionService
}

export function operatorEventRoutes(deps: OperatorEventRouteDeps) {
  const { db, authConfig, sseManager, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /operators/activity-stream — SSE activity stream
    // -----------------------------------------------------------------
    app.get<{ Querystring: ActivityStreamQuery }>(
      "/operators/activity-stream",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          querystring: {
            type: "object",
            properties: {
              agentIds: { type: "string" },
              eventTypes: { type: "string" },
              since: { type: "string" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Querystring: ActivityStreamQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentIds, eventTypes, since } = request.query

        const agentIdList = agentIds ? agentIds.split(",").filter(Boolean) : null
        const eventTypeList = eventTypes ? eventTypes.split(",").filter(Boolean) : null

        // Replay historical events since the given timestamp or Last-Event-ID
        const lastEventId = (request.headers["last-event-id"] as string | undefined) ?? null

        const raw = reply.raw

        // Replay historical events from DB if `since` or Last-Event-ID provided
        let replayEvents: Array<{
          id: string
          agent_id: string
          event_type: string
          payload: Record<string, unknown>
          tokens_in: number | null
          tokens_out: number | null
          cost_usd: string | null
          tool_ref: string | null
          created_at: Date
        }> = []

        if (since || lastEventId) {
          let query = db
            .selectFrom("agent_event")
            .selectAll()
            .orderBy("created_at", "asc")
            .limit(1000)

          if (since) {
            query = query.where("created_at", ">=", new Date(since))
          }
          if (agentIdList) {
            query = query.where("agent_id", "in", agentIdList)
          }
          if (eventTypeList) {
            query = query.where("event_type", "in", eventTypeList)
          }

          replayEvents = await query.execute()
        }

        // Connect to SSE manager — sets headers and starts heartbeat
        const channelId = `_activity_stream:${Date.now()}`
        sseManager.connect(channelId, raw, lastEventId)

        // Replay historical events through the connection
        if (replayEvents.length > 0) {
          let pastLastId = !lastEventId
          for (const event of replayEvents) {
            if (!pastLastId) {
              if (event.id === lastEventId) {
                pastLastId = true
              }
              continue
            }
            const data = formatEventData(event)
            sseManager.broadcast(channelId, "agent:output", {
              agentId: event.agent_id,
              timestamp: event.created_at.toISOString(),
              output: { type: "event", eventType: event.event_type, ...data },
            })
          }
        }

        // Clean up on client disconnect
        request.raw.on("close", () => {
          sseManager.disconnectAll(channelId)
        })

        reply.hijack()
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/events — paginated event list
    // -----------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: EventListQuery }>(
      "/agents/:agentId/events",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              eventTypes: { type: "string" },
              since: { type: "string" },
              until: { type: "string" },
              limit: { type: "number", minimum: 1, maximum: 200 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: EventListQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { eventTypes, since, until, limit = 50, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Build base where clause
        let baseQuery = db.selectFrom("agent_event").where("agent_id", "=", agentId)

        if (eventTypes) {
          const types = eventTypes.split(",").filter(Boolean)
          if (types.length > 0) {
            baseQuery = baseQuery.where("event_type", "in", types)
          }
        }
        if (since) {
          baseQuery = baseQuery.where("created_at", ">=", new Date(since))
        }
        if (until) {
          baseQuery = baseQuery.where("created_at", "<=", new Date(until))
        }

        const [events, countResult, costResult] = await Promise.all([
          baseQuery.selectAll().orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          baseQuery.select(db.fn.countAll<number>().as("total")).executeTakeFirstOrThrow(),
          baseQuery
            .select([
              sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("total_usd"),
              sql<number>`coalesce(sum(tokens_in), 0)`.as("tokens_in"),
              sql<number>`coalesce(sum(tokens_out), 0)`.as("tokens_out"),
            ])
            .executeTakeFirstOrThrow(),
        ])

        return reply.status(200).send({
          events: events.map((e) => ({
            id: e.id,
            agentId: e.agent_id,
            eventType: e.event_type,
            payload: e.payload,
            tokensIn: e.tokens_in,
            tokensOut: e.tokens_out,
            costUsd: e.cost_usd ? Number(e.cost_usd) : null,
            toolRef: e.tool_ref,
            createdAt: e.created_at,
          })),
          total: Number(countResult.total),
          costSummary: {
            totalUsd: Number(costResult.total_usd),
            tokensIn: Number(costResult.tokens_in),
            tokensOut: Number(costResult.tokens_out),
          },
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/cost — cost aggregation
    // -----------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: CostQuery }>(
      "/agents/:agentId/cost",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              since: { type: "string" },
              until: { type: "string" },
              groupBy: { type: "string", enum: ["model", "session", "day"] },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: CostQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { since, until, groupBy = "model" } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Build base query for summary
        let summaryQuery = db
          .selectFrom("agent_event")
          .where("agent_id", "=", agentId)
          .where("cost_usd", "is not", null)

        if (since) {
          summaryQuery = summaryQuery.where("created_at", ">=", new Date(since))
        }
        if (until) {
          summaryQuery = summaryQuery.where("created_at", "<=", new Date(until))
        }

        const summaryResult = await summaryQuery
          .select([
            sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("total_usd"),
            sql<number>`coalesce(sum(tokens_in), 0)`.as("tokens_in"),
            sql<number>`coalesce(sum(tokens_out), 0)`.as("tokens_out"),
          ])
          .executeTakeFirstOrThrow()

        // Build breakdown query
        let breakdownQuery = db
          .selectFrom("agent_event")
          .where("agent_id", "=", agentId)
          .where("cost_usd", "is not", null)

        if (since) {
          breakdownQuery = breakdownQuery.where("created_at", ">=", new Date(since))
        }
        if (until) {
          breakdownQuery = breakdownQuery.where("created_at", "<=", new Date(until))
        }

        let breakdownRows: Array<{
          group_key: string | null
          cost: string
          tokens_in: number
          tokens_out: number
        }>

        if (groupBy === "day") {
          breakdownRows = await breakdownQuery
            .select([
              sql<string>`cast(date_trunc('day', created_at) as text)`.as("group_key"),
              sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("cost"),
              sql<number>`coalesce(sum(tokens_in), 0)`.as("tokens_in"),
              sql<number>`coalesce(sum(tokens_out), 0)`.as("tokens_out"),
            ])
            .groupBy(sql`date_trunc('day', created_at)`)
            .orderBy(sql`date_trunc('day', created_at)`, "asc")
            .execute()
        } else {
          const col = groupBy === "session" ? ("session_id" as const) : ("model" as const)
          breakdownRows = await breakdownQuery
            .select([
              sql<string | null>`${sql.ref(col)}`.as("group_key"),
              sql<string>`coalesce(sum(cast(cost_usd as double precision)), 0)`.as("cost"),
              sql<number>`coalesce(sum(tokens_in), 0)`.as("tokens_in"),
              sql<number>`coalesce(sum(tokens_out), 0)`.as("tokens_out"),
            ])
            .groupBy(col)
            .orderBy(sql`coalesce(sum(cast(cost_usd as double precision)), 0)`, "desc")
            .execute()
        }

        return reply.status(200).send({
          summary: {
            totalUsd: Number(summaryResult.total_usd),
            tokensIn: Number(summaryResult.tokens_in),
            tokensOut: Number(summaryResult.tokens_out),
          },
          breakdown: breakdownRows.map((r) => ({
            [groupBy]: r.group_key,
            costUsd: Number(r.cost),
            tokensIn: Number(r.tokens_in),
            tokensOut: Number(r.tokens_out),
          })),
        })
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventData(event: {
  id: string
  agent_id: string
  event_type: string
  payload: Record<string, unknown>
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: string | null
  tool_ref: string | null
  created_at: Date
}): Record<string, unknown> {
  return {
    id: event.id,
    agentId: event.agent_id,
    eventType: event.event_type,
    payload: event.payload,
    tokensIn: event.tokens_in,
    tokensOut: event.tokens_out,
    costUsd: event.cost_usd ? Number(event.cost_usd) : null,
    toolRef: event.tool_ref,
    createdAt: event.created_at,
  }
}
