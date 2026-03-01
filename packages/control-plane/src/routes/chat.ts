/**
 * Chat Routes
 *
 * POST /agents/:agentId/chat — Send a chat message and get a response
 *
 * Provides a REST interface for the same flow that channel adapters use:
 * session management → message storage → job creation → response relay.
 */

import type { JobStatus } from "@cortex/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import { loadConversationHistory, watchJobCompletion } from "../channels/message-dispatch.js"
import type { Database } from "../db/types.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"
import type { AuthenticatedRequest } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface ChatParams {
  agentId: string
}

interface ChatBody {
  text: string
  session_id?: string
}

interface ChatQuery {
  wait?: boolean
  timeout?: number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface ChatRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  enqueueJob: (jobId: string) => Promise<void>
  sessionService?: SessionService
}

export function chatRoutes(deps: ChatRouteDeps) {
  const { db, authConfig, enqueueJob, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /agents/:agentId/chat — Send a chat message
    // -----------------------------------------------------------------
    app.post<{ Params: ChatParams; Body: ChatBody; Querystring: ChatQuery }>(
      "/agents/:agentId/chat",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1, maxLength: 50_000 },
              session_id: { type: "string" },
            },
            required: ["text"],
          },
          querystring: {
            type: "object",
            properties: {
              wait: { type: "boolean" },
              timeout: { type: "number", minimum: 1000, maximum: 120_000 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{
          Params: ChatParams
          Body: ChatBody
          Querystring: ChatQuery
        }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { text, session_id: requestedSessionId } = request.body
        const wait = request.query.wait ?? false
        const timeout = request.query.timeout ?? 60_000

        // Verify agent exists and is active
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status !== "ACTIVE") {
          return reply.status(409).send({
            error: "conflict",
            message: `Agent is ${agent.status}, must be ACTIVE to accept messages`,
          })
        }

        // Resolve user from auth principal
        const principal = (request as AuthenticatedRequest).principal
        const userAccountId = principal?.userId ?? "api-user"

        // Find or create session
        const channelId = "rest:api"
        const session = await findOrCreateSession(
          db,
          agentId,
          userAccountId,
          channelId,
          requestedSessionId,
        )

        // Store user message
        await db
          .insertInto("session_message")
          .values({
            session_id: session.id,
            role: "user",
            content: text,
          })
          .execute()

        // Load conversation history
        const conversationHistory = await loadConversationHistory(db, session.id)

        // Create job
        const job = await db
          .insertInto("job")
          .values({
            agent_id: agentId,
            session_id: session.id,
            payload: {
              type: "CHAT_RESPONSE",
              prompt: text,
              goalType: "research",
              conversationHistory,
            },
            priority: 0,
            max_attempts: 3,
            timeout_seconds: 120,
          })
          .returning("id")
          .executeTakeFirstOrThrow()

        // Transition PENDING → SCHEDULED
        await db
          .updateTable("job")
          .set({ status: "SCHEDULED" as JobStatus })
          .where("id", "=", job.id)
          .execute()

        // Enqueue worker task
        try {
          await enqueueJob(job.id)
        } catch (err) {
          request.log.warn({ err, jobId: job.id }, "Failed to enqueue chat job via Graphile Worker")
        }

        if (!wait) {
          return reply.status(202).send({
            job_id: job.id,
            session_id: session.id,
            status: "SCHEDULED",
          })
        }

        // Synchronous wait: poll for completion and return the response inline
        const result = await waitForJob(db, job.id, timeout)

        if (!result) {
          return reply.status(202).send({
            job_id: job.id,
            session_id: session.id,
            status: "RUNNING",
            message: "Job is still running. Poll GET /agents/:id/jobs for status.",
          })
        }

        const responseText =
          typeof result.result?.stdout === "string" && result.result.stdout.length > 0
            ? result.result.stdout
            : typeof result.result?.summary === "string" && result.result.summary.length > 0
              ? result.result.summary
              : null

        if (responseText) {
          // Store assistant response
          await db
            .insertInto("session_message")
            .values({
              session_id: session.id,
              role: "assistant",
              content: responseText,
            })
            .execute()
        }

        return reply.status(200).send({
          job_id: job.id,
          session_id: session.id,
          status: result.status,
          response: responseText,
        })
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findOrCreateSession(
  db: Kysely<Database>,
  agentId: string,
  userAccountId: string,
  channelId: string,
  requestedSessionId?: string,
): Promise<{ id: string }> {
  // If a specific session is requested, verify and use it
  if (requestedSessionId) {
    const existing = await db
      .selectFrom("session")
      .select("id")
      .where("id", "=", requestedSessionId)
      .where("agent_id", "=", agentId)
      .where("status", "=", "active")
      .executeTakeFirst()

    if (existing) return existing
  }

  // Try to find existing active session
  const existing = await db
    .selectFrom("session")
    .select("id")
    .where("agent_id", "=", agentId)
    .where("user_account_id", "=", userAccountId)
    .where("channel_id", "=", channelId)
    .where("status", "=", "active")
    .executeTakeFirst()

  if (existing) return existing

  // Create new session
  return db
    .insertInto("session")
    .values({
      agent_id: agentId,
      user_account_id: userAccountId,
      channel_id: channelId,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
}

function waitForJob(
  db: Kysely<Database>,
  jobId: string,
  timeoutMs: number,
): Promise<{ status: string; result: Record<string, unknown> } | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let resolved = false

    watchJobCompletion(
      db,
      jobId,
      (_result, status) => {
        if (!resolved) {
          resolved = true
          resolve({
            status,
            result: (_result as Record<string, unknown>) ?? {},
          })
        }
        return Promise.resolve()
      },
      { warn: () => {} },
      { intervalMs: 1_000, timeoutMs },
    )

    // Fallback timeout (slightly after watchJobCompletion's own timeout)
    setTimeout(
      () => {
        if (!resolved) {
          resolved = true
          resolve(null)
        }
      },
      deadline - Date.now() + 2_000,
    )
  })
}
