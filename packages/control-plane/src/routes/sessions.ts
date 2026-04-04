/**
 * Session Routes
 *
 * GET    /agents/:id/sessions       — List sessions for an agent
 * GET    /sessions/:id/messages     — Get conversation history for a session
 * DELETE /sessions/:id              — Clear / reset a session
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import {
  closeSessionRecord,
  getSessionRecord,
  resumeSessionRecord,
  SessionResolutionError,
} from "../chat/session-record.js"
import type { Database } from "../db/types.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentParams {
  id: string
}

interface SessionParams {
  id: string
}

interface ListSessionsQuery {
  limit?: number
  offset?: number
}

interface ListMessagesQuery {
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface SessionRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function sessionRoutes(deps: SessionRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /agents/:id/sessions — List sessions for an agent
    // -----------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: ListSessionsQuery }>(
      "/agents/:id/sessions",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          querystring: {
            type: "object",
            properties: {
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: ListSessionsQuery }>,
        reply: FastifyReply,
      ) => {
        const { id: agentId } = request.params
        const { limit = 50, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        const sessions = await db
          .selectFrom("session")
          .selectAll()
          .where("agent_id", "=", agentId)
          .orderBy("updated_at", "desc")
          .limit(limit)
          .offset(offset)
          .execute()

        return reply.status(200).send({ sessions, count: sessions.length })
      },
    )

    // -----------------------------------------------------------------
    // GET /sessions/:id — Fetch a single session record
    // -----------------------------------------------------------------
    app.get<{ Params: SessionParams }>(
      "/sessions/:id",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
        const session = await getSessionRecord(db, request.params.id)
        if (!session) {
          return reply.status(404).send({ error: "not_found", message: "Session not found" })
        }
        return reply.status(200).send(session)
      },
    )

    // -----------------------------------------------------------------
    // GET /sessions/:id/messages — Get conversation history
    // -----------------------------------------------------------------
    app.get<{ Params: SessionParams; Querystring: ListMessagesQuery }>(
      "/sessions/:id/messages",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          querystring: {
            type: "object",
            properties: {
              limit: { type: "number", minimum: 1, maximum: 200 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: SessionParams; Querystring: ListMessagesQuery }>,
        reply: FastifyReply,
      ) => {
        const { id: sessionId } = request.params
        const { limit = 100, offset = 0 } = request.query

        // Verify session exists
        const session = await db
          .selectFrom("session")
          .select("id")
          .where("id", "=", sessionId)
          .executeTakeFirst()

        if (!session) {
          return reply.status(404).send({ error: "not_found", message: "Session not found" })
        }

        const messages = await db
          .selectFrom("session_message")
          .selectAll()
          .where("session_id", "=", sessionId)
          .orderBy("created_at", "asc")
          .limit(limit)
          .offset(offset)
          .execute()

        return reply.status(200).send({ messages, count: messages.length })
      },
    )

    // -----------------------------------------------------------------
    // POST /sessions/:id/resume — Resume a reusable session
    // -----------------------------------------------------------------
    app.post<{ Params: SessionParams }>(
      "/sessions/:id/resume",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
        try {
          const session = await resumeSessionRecord(db, {
            sessionId: request.params.id,
            source: {
              surface: "ui",
              channelType: "rest",
              channelId: "rest:api",
              chatId: "rest:api",
            },
          })
          return reply.status(200).send({ session, action: "resumed" })
        } catch (error) {
          if (error instanceof SessionResolutionError) {
            return reply.status(error.code === "closed" ? 409 : 404).send({
              error: error.code,
              message: error.message,
            })
          }
          throw error
        }
      },
    )

    // -----------------------------------------------------------------
    // DELETE /sessions/:id — Close a session
    // -----------------------------------------------------------------
    app.delete<{ Params: SessionParams }>(
      "/sessions/:id",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
        const session = await closeSessionRecord(db, {
          sessionId: request.params.id,
          source: {
            surface: "ui",
            channelType: "rest",
            channelId: "rest:api",
            chatId: "rest:api",
          },
        })
        if (!session) {
          return reply.status(404).send({ error: "not_found", message: "Session not found" })
        }

        return reply.status(200).send({ id: session.id, status: "closed", action: "closed" })
      },
    )
  }
}
