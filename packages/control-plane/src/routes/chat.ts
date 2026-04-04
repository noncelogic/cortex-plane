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

import type { ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { SessionService } from "../auth/session-service.js"
import type { UserRateLimiter } from "../auth/user-rate-limiter.js"
import type { CapabilityAssembler } from "../capabilities/index.js"
import { loadConversationHistory, watchJobCompletion } from "../channels/message-dispatch.js"
import {
  mapJobErrorToUserMessage,
  type PreflightResult,
  runPreflight,
} from "../channels/preflight.js"
import {
  buildChatDispatchDiagnostics,
  type ResolvedProviderModelContract,
  type SessionResolutionDiagnostics,
} from "../chat/runtime-contract.js"
import type { Database, RateLimit, TokenBudget } from "../db/types.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"
import type { AuthenticatedRequest } from "../middleware/types.js"
import { ensureUuid } from "../util/name-uuid.js"

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
  channelAuthGuard?: ChannelAuthGuard
  userRateLimiter?: UserRateLimiter
  capabilityAssembler?: CapabilityAssembler
}

export function chatRoutes(deps: ChatRouteDeps) {
  const {
    db,
    authConfig,
    enqueueJob,
    sessionService,
    channelAuthGuard,
    userRateLimiter,
    capabilityAssembler,
  } = deps

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

        // Verify agent is ready (status + credential)
        const preflight = await runPreflight(db, agentId)
        if (!preflight.ok) {
          const statusCode = preflight.code === "agent_not_active" ? 409 : 422
          return reply.status(statusCode).send({
            error: preflight.code ?? "preflight_failed",
            message: preflight.userMessage,
          })
        }

        // Resolve user from auth principal (ensureUuid is defence-in-depth;
        // the auth middleware already normalises principal.userId to a UUID).
        const principal = (request as AuthenticatedRequest).principal
        const userAccountId = ensureUuid(principal?.userId ?? "api-user")

        // Ensure principal user exists for session FK integrity (dev/api-key modes).
        await ensureUserAccount(db, userAccountId, principal?.displayName ?? "api-user")

        // Per-agent authorization guard (operators own all agents — skip the gate)
        let grantId: string | undefined
        if (channelAuthGuard && principal?.userRole !== "operator") {
          const decision = await channelAuthGuard.authorize({
            agentId,
            channelType: "rest",
            channelUserId: userAccountId,
            chatId: "rest:api",
            messageText: text,
          })

          if (!decision.allowed) {
            return reply.status(403).send({
              error: "forbidden",
              message: decision.replyToUser ?? "Access denied",
              reason: decision.reason,
            })
          }

          grantId = decision.grantId
        }

        // Per-user rate limit & token budget enforcement
        if (userRateLimiter && grantId) {
          const grant = await db
            .selectFrom("agent_user_grant")
            .select(["rate_limit", "token_budget"])
            .where("id", "=", grantId)
            .executeTakeFirst()

          const grantRateLimit = grant?.rate_limit as RateLimit | null | undefined
          const grantTokenBudget = grant?.token_budget as TokenBudget | null | undefined

          const rateLimitDecision = await userRateLimiter.check(
            userAccountId,
            agentId,
            grantRateLimit ?? undefined,
            grantTokenBudget ?? undefined,
          )

          if (!rateLimitDecision.allowed) {
            return reply
              .status(429)
              .header("Retry-After", String(rateLimitDecision.retryAfterSeconds ?? 60))
              .send({
                error: rateLimitDecision.reason,
                message: rateLimitDecision.replyToUser ?? "Rate limit exceeded",
              })
          }
        }

        // Find or create session
        const channelId = "rest:api"
        const session = await findOrCreateSession(
          db,
          agentId,
          userAccountId,
          channelId,
          requestedSessionId,
        )
        const source: SessionResolutionDiagnostics = {
          surface: "ui",
          channelType: "rest",
          channelId,
          chatId: "rest:api",
        }
        const toolRefs = capabilityAssembler
          ? (await capabilityAssembler.resolveEffectiveTools(agentId)).map((tool) => tool.toolRef)
          : undefined
        const chatDiagnostics = buildChatDispatchDiagnostics({
          agentId,
          sessionId: session.id,
          source,
          providerModel: extractProviderModelDiagnostics(preflight),
          toolRefs,
          toolContractMode: capabilityAssembler ? "effective" : "legacy",
        })

        // Store user message
        await db
          .insertInto("session_message")
          .values({
            session_id: session.id,
            role: "user",
            content: text,
            metadata: {
              source,
            },
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
              chatDiagnostics,
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
            diagnostics: chatDiagnostics,
          })
        }

        // Synchronous wait: poll for completion and return the response inline
        const result = await waitForJob(db, job.id, timeout, request.log)

        if (!result) {
          return reply.status(202).send({
            job_id: job.id,
            session_id: session.id,
            status: "RUNNING",
            message: "Job is still running. Poll GET /agents/:id/jobs for status.",
            diagnostics: chatDiagnostics,
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

        // Job is waiting for human approval — return approval-needed status
        if (result.status === "WAITING_FOR_APPROVAL") {
          return reply.status(200).send({
            job_id: job.id,
            session_id: session.id,
            status: "WAITING_FOR_APPROVAL",
            response: null,
            approval_needed: true,
            diagnostics: extractChatDiagnostics({
              payload: { chatDiagnostics },
              result: result.result,
              error: result.error,
            }),
          })
        }

        // Surface error details for failed/timed-out jobs
        const isFailed = result.status === "FAILED" || result.status === "TIMED_OUT"
        if (isFailed && !responseText) {
          const errorMessage =
            result.status === "TIMED_OUT"
              ? "The request timed out. Please try again."
              : mapJobErrorToUserMessage(result.error)
          return reply.status(200).send({
            job_id: job.id,
            session_id: session.id,
            status: result.status,
            response: null,
            error: {
              message: errorMessage,
              code: result.status === "TIMED_OUT" ? "job_timed_out" : "job_failed",
            },
            diagnostics: extractChatDiagnostics({
              payload: { chatDiagnostics },
              result: result.result,
              error: result.error,
            }),
          })
        }

        return reply.status(200).send({
          job_id: job.id,
          session_id: session.id,
          status: result.status,
          response: responseText,
          diagnostics: extractChatDiagnostics({
            payload: { chatDiagnostics },
            result: result.result,
            error: result.error,
          }),
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/chat/jobs/:jobId — Poll job status for chat
    // -----------------------------------------------------------------
    app.get<{ Params: { agentId: string; jobId: string } }>(
      "/agents/:agentId/chat/jobs/:jobId",
      {
        preHandler: [requireAuth],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              jobId: { type: "string" },
            },
            required: ["agentId", "jobId"],
          },
        },
      },
      async (request, reply) => {
        const { agentId, jobId } = request.params

        const row = await db
          .selectFrom("job")
          .select(["status", "result", "error", "session_id", "payload"])
          .where("id", "=", jobId)
          .where("agent_id", "=", agentId)
          .executeTakeFirst()

        if (!row) {
          return reply.status(404).send({ error: "not_found", message: "Job not found" })
        }

        const result = row.result
        const responseText =
          typeof result?.stdout === "string" && result.stdout.length > 0
            ? result.stdout
            : typeof result?.summary === "string" && result.summary.length > 0
              ? result.summary
              : null

        // Store assistant response on completion (if not already stored)
        if (responseText && (row.status === "COMPLETED" || row.status === "FAILED")) {
          const sessionId = row.session_id
          if (sessionId) {
            const existing = await db
              .selectFrom("session_message")
              .select("id")
              .where("session_id", "=", sessionId)
              .where("role", "=", "assistant")
              .where("content", "=", responseText)
              .executeTakeFirst()

            if (!existing) {
              await db
                .insertInto("session_message")
                .values({
                  session_id: sessionId,
                  role: "assistant",
                  content: responseText,
                })
                .execute()
            }
          }
        }

        if (row.status === "WAITING_FOR_APPROVAL") {
          return reply.status(200).send({
            job_id: jobId,
            session_id: row.session_id,
            status: "WAITING_FOR_APPROVAL",
            response: null,
            approval_needed: true,
            diagnostics: extractChatDiagnostics(row),
          })
        }

        const isFailed = row.status === "FAILED" || row.status === "TIMED_OUT"
        if (isFailed && !responseText) {
          const jobError = row.error
          const errorMessage =
            row.status === "TIMED_OUT"
              ? "The request timed out. Please try again."
              : mapJobErrorToUserMessage(jobError)
          return reply.status(200).send({
            job_id: jobId,
            session_id: row.session_id,
            status: row.status,
            response: null,
            error: {
              message: errorMessage,
              code: row.status === "TIMED_OUT" ? "job_timed_out" : "job_failed",
            },
            diagnostics: extractChatDiagnostics(row),
          })
        }

        return reply.status(200).send({
          job_id: jobId,
          session_id: row.session_id,
          status: row.status,
          response: responseText,
          diagnostics: extractChatDiagnostics(row),
        })
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureUserAccount(
  db: Kysely<Database>,
  userAccountId: string,
  displayName?: string,
): Promise<void> {
  const existing = await db
    .selectFrom("user_account")
    .select("id")
    .where("id", "=", userAccountId)
    .executeTakeFirst()

  if (existing) return

  await db
    .insertInto("user_account")
    .values({
      id: userAccountId,
      display_name: displayName ?? null,
      role: "operator",
    })
    .execute()
}

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

interface WaitForJobResult {
  status: string
  result: Record<string, unknown>
  error: Record<string, unknown> | null
}

function extractProviderModelDiagnostics(
  preflight: PreflightResult,
): ResolvedProviderModelContract {
  const providerModel = preflight.diagnostics?.providerModel
  if (providerModel && typeof providerModel === "object") {
    return providerModel as ResolvedProviderModelContract
  }
  return {
    requestedProvider: null,
    requestedModel: null,
    resolvedProvider: null,
    resolvedModel: null,
    boundProviders: [],
    bindingRequired: false,
    mismatchCode: null,
    mismatchMessage: null,
  }
}

function extractChatDiagnostics(row: {
  payload?: Record<string, unknown> | null
  result?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}): Record<string, unknown> | undefined {
  const payloadDiagnostics =
    row.payload?.chatDiagnostics &&
    typeof row.payload.chatDiagnostics === "object" &&
    row.payload.chatDiagnostics !== null
      ? (row.payload.chatDiagnostics as Record<string, unknown>)
      : undefined

  const resultDiagnostics =
    row.result?.runtime && typeof row.result.runtime === "object" && row.result.runtime !== null
      ? (row.result.runtime as Record<string, unknown>)
      : undefined

  const errorDiagnostics =
    row.error && typeof row.error === "object"
      ? {
          error: row.error,
        }
      : undefined

  if (!payloadDiagnostics && !resultDiagnostics && !errorDiagnostics) {
    return undefined
  }

  return {
    ...(payloadDiagnostics ? { requested: payloadDiagnostics } : {}),
    ...(resultDiagnostics ? { runtime: resultDiagnostics } : {}),
    ...(errorDiagnostics ?? {}),
  }
}

function waitForJob(
  db: Kysely<Database>,
  jobId: string,
  timeoutMs: number,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<WaitForJobResult | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let resolved = false

    watchJobCompletion(
      db,
      jobId,
      (_result, status) => {
        if (!resolved) {
          resolved = true
          // Fetch the error column separately (watchJobCompletion only returns result)
          void db
            .selectFrom("job")
            .select(["error"])
            .where("id", "=", jobId)
            .executeTakeFirst()
            .then((row) => {
              resolve({
                status,
                result: (_result as Record<string, unknown>) ?? {},
                error: (row?.error as Record<string, unknown>) ?? null,
              })
            })
            .catch((fetchErr: unknown) => {
              log.warn({ err: fetchErr, jobId }, "Failed to fetch error column for completed job")
              resolve({
                status,
                result: (_result as Record<string, unknown>) ?? {},
                error: { message: "Job failed but error details could not be retrieved." },
              })
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
