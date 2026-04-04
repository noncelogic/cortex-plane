/**
 * Message Dispatch Handler
 *
 * The message handler that MessageRouter.onMessage() calls:
 * 1. Receive RoutedMessage (user resolved)
 * 2. Look up agent binding for (channelType, chatId) via AgentChannelService
 * 3. If no binding, check for default agent for this channel type
 * 4. If still no agent, send a reply: "No agent is assigned to this chat."
 * 5. If agent found, find or create a session for (agent_id, user_account_id, channel_id)
 * 6. Store the inbound message in session_message
 * 7. Load conversation history from session_message
 * 8. Create a job row and enqueue agent_execute via Graphile Worker
 * 9. Watch for job completion, store assistant response, and relay back to chat
 */

import type { JobStatus } from "@cortex/shared"
import type { MessageRouter, RoutedMessage } from "@cortex/shared/channels"
import type { Kysely } from "kysely"

import type { AuthDecision, ChannelAuthGuard } from "../auth/channel-auth-guard.js"
import type { UserRateLimiter } from "../auth/user-rate-limiter.js"
import type { CapabilityAssembler } from "../capabilities/index.js"
import {
  buildChatDispatchDiagnostics,
  type ResolvedProviderModelContract,
  type SessionResolutionDiagnostics,
} from "../chat/runtime-contract.js"
import type { ChannelType, Database, RateLimit, TokenBudget } from "../db/types.js"
import type { AgentEventEmitter } from "../observability/event-emitter.js"
import type { AgentChannelService } from "./agent-channel-service.js"
import { mapJobErrorToUserMessage, type PreflightResult, runPreflight } from "./preflight.js"

/** Pattern matching pairing codes (6-char uppercase alphanumeric). */
const PAIRING_CODE_PATTERN = /^[A-Z0-9]{6}$/

export interface MessageDispatchDeps {
  db: Kysely<Database>
  agentChannelService: AgentChannelService
  router: MessageRouter
  enqueueJob: (jobId: string) => Promise<void>
  channelAuthGuard?: ChannelAuthGuard
  userRateLimiter?: UserRateLimiter
  eventEmitter?: AgentEventEmitter
  capabilityAssembler?: CapabilityAssembler
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

const NO_AGENT_MESSAGE = "No agent is assigned to this chat. Use the dashboard to connect an agent."

/** Default polling interval (ms) for job completion checks. */
const JOB_POLL_INTERVAL_MS = 2_000

/** Maximum time (ms) to wait for a job to complete before giving up. */
const JOB_POLL_TIMEOUT_MS = 120_000

/** Maximum number of recent messages to include as conversation history. */
const MAX_HISTORY_MESSAGES = 50

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<JobStatus>([
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "DEAD_LETTER",
  "WAITING_FOR_APPROVAL",
])

/**
 * Create a message handler that dispatches routed messages to the correct agent session.
 */
export function createMessageDispatch(
  deps: MessageDispatchDeps,
): (msg: RoutedMessage) => Promise<void> {
  const {
    db,
    agentChannelService,
    router,
    enqueueJob,
    channelAuthGuard,
    userRateLimiter,
    eventEmitter,
    capabilityAssembler,
    logger = console,
  } = deps

  return async function dispatch(routed: RoutedMessage): Promise<void> {
    const { channelType, chatId } = routed.message

    // Resolve the agent for this channel + chat
    const agentId = await agentChannelService.resolveAgent(channelType, chatId)

    if (!agentId) {
      // No agent bound — notify the user
      logger.warn(
        { channelType, chatId, userAccountId: routed.userAccountId },
        "No agent binding found for chat",
      )
      await router.send(channelType, chatId, { text: NO_AGENT_MESSAGE })
      return
    }

    // ── Preflight: agent status + credential check ────────────────────
    const preflight = await runPreflight(db, agentId)
    if (!preflight.ok) {
      logger.warn(
        { agentId, channelType, chatId, code: preflight.code },
        "Preflight check failed — agent not ready for dispatch",
      )
      await router.send(channelType, chatId, { text: preflight.userMessage! })
      return
    }

    // ── Resolve channel config for allowlist gate ──────────────────────
    const channelConfig = await db
      .selectFrom("channel_config")
      .select("id")
      .where("type", "=", channelType as ChannelType)
      .where("enabled", "=", true)
      .executeTakeFirst()

    // ── Channel authorization guard ────────────────────────────────────
    let authDecision: AuthDecision | undefined

    if (channelAuthGuard) {
      // Intercept pairing codes before running the full auth flow
      if (routed.message.text && PAIRING_CODE_PATTERN.test(routed.message.text)) {
        const pairingResult = await channelAuthGuard.handlePairingCode(
          routed.message.text,
          routed.channelMappingId,
          routed.userAccountId,
        )
        await router.send(channelType, chatId, { text: pairingResult.message })
        return
      }

      authDecision = await channelAuthGuard.authorize({
        agentId,
        channelType,
        channelUserId: routed.message.channelUserId,
        chatId,
        messageText: routed.message.text,
        channelConfigId: channelConfig?.id,
      })

      if (!authDecision.allowed) {
        if (authDecision.replyToUser) {
          await router.send(channelType, chatId, { text: authDecision.replyToUser })
        }
        if (eventEmitter) {
          await eventEmitter.emit({
            agentId,
            eventType: "message_denied",
            actor: "system",
            payload: {
              reason: authDecision.reason,
              channelType,
              chatId,
              userId: authDecision.userId,
            },
          })
        }
        logger.info(
          { agentId, channelType, chatId, reason: authDecision.reason },
          "Message blocked by ChannelAuthGuard",
        )
        return
      }
    }

    // ── Per-user rate limit & token budget enforcement ──────────────────
    if (userRateLimiter && authDecision?.allowed && authDecision.grantId) {
      // Fetch grant's rate_limit and token_budget for cascade resolution
      const grant = await db
        .selectFrom("agent_user_grant")
        .select(["rate_limit", "token_budget"])
        .where("id", "=", authDecision.grantId)
        .executeTakeFirst()

      const grantRateLimit = grant?.rate_limit as RateLimit | null | undefined
      const grantTokenBudget = grant?.token_budget as TokenBudget | null | undefined

      const rateLimitDecision = await userRateLimiter.check(
        authDecision.userId,
        agentId,
        grantRateLimit ?? undefined,
        grantTokenBudget ?? undefined,
      )

      if (!rateLimitDecision.allowed) {
        if (rateLimitDecision.replyToUser) {
          await router.send(channelType, chatId, { text: rateLimitDecision.replyToUser })
        }
        if (eventEmitter) {
          await eventEmitter.emit({
            agentId,
            eventType: "message_denied",
            actor: "system",
            payload: {
              reason: rateLimitDecision.reason,
              channelType,
              chatId,
              userId: authDecision.userId,
            },
          })
        }
        logger.info(
          { agentId, channelType, chatId, reason: rateLimitDecision.reason },
          "Message blocked by rate limiter",
        )
        return
      }
    }

    // Build channel_id as "channelType:chatId" for session scoping
    const channelId = `${channelType}:${chatId}`

    // Find or create a session for (agent_id, user_account_id, channel_id)
    const session = await findOrCreateSession(db, agentId, routed.userAccountId, channelId)
    const source: SessionResolutionDiagnostics = {
      surface: "channel",
      channelType,
      channelId,
      chatId,
      messageId: routed.message.messageId,
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

    // Store inbound user message
    await db
      .insertInto("session_message")
      .values({
        session_id: session.id,
        role: "user",
        content: routed.message.text,
        metadata: {
          source,
        },
      })
      .execute()

    // Load conversation history from session_message
    const conversationHistory = await loadConversationHistory(db, session.id)

    // Create a job row
    const job = await db
      .insertInto("job")
      .values({
        agent_id: agentId,
        session_id: session.id,
        payload: {
          type: "CHAT_RESPONSE",
          prompt: routed.message.text,
          goalType: "research",
          conversationHistory,
          chatDiagnostics,
          ...(authDecision && {
            authorizedUserId: authDecision.userId,
            grantId: authDecision.grantId,
          }),
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
      logger.warn({ err, jobId: job.id }, "Failed to enqueue job via Graphile Worker")
      // Job is in the DB as SCHEDULED — the worker cron will pick it up
    }

    logger.info(
      {
        agentId,
        sessionId: session.id,
        jobId: job.id,
        userAccountId: routed.userAccountId,
        channelType,
        chatId,
        messageId: routed.message.messageId,
      },
      "Chat message dispatched — job created",
    )

    // Fire-and-forget: watch for job completion and relay the response
    watchJobCompletion(
      db,
      job.id,
      async (result, status, error) => {
        // For failed/timed-out jobs, always send a user-friendly error message
        // instead of raw stdout (which may contain provider JSON / internal details).
        if (status === "FAILED" || status === "TIMED_OUT") {
          const errMsg =
            status === "TIMED_OUT"
              ? "The request timed out. Please try again."
              : mapJobErrorToUserMessage(error ?? result)
          await router.send(channelType, chatId, { text: errMsg })
          return
        }

        // Prefer the full response text (stdout) over the truncated summary
        const responseText =
          typeof result?.stdout === "string" && result.stdout.length > 0
            ? result.stdout
            : typeof result?.summary === "string" && result.summary.length > 0
              ? result.summary
              : null

        if (responseText) {
          // Store assistant response in session_message
          await db
            .insertInto("session_message")
            .values({
              session_id: session.id,
              role: "assistant",
              content: responseText,
            })
            .execute()

          await router.send(channelType, chatId, { text: responseText })
        }
      },
      logger,
      {
        onTimeout: async () => {
          await router.send(channelType, chatId, {
            text: "The request timed out. Please try again.",
          })
        },
      },
    )
  }
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

/** Callback signature for job completion watchers. */
export type JobCompletionCallback = (
  result: Record<string, unknown> | null,
  status: string,
  error: Record<string, unknown> | null,
) => Promise<void>

/**
 * Poll the job table for a terminal status, then invoke the callback with the result.
 * Runs in the background — does not block the dispatch handler.
 */
export function watchJobCompletion(
  db: Kysely<Database>,
  jobId: string,
  onComplete: JobCompletionCallback,
  logger: { warn: (...args: unknown[]) => void },
  opts: { intervalMs?: number; timeoutMs?: number; onTimeout?: () => Promise<void> } = {},
): void {
  const intervalMs = opts.intervalMs ?? JOB_POLL_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? JOB_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  const timer = setInterval(() => {
    void (async () => {
      if (Date.now() > deadline) {
        clearInterval(timer)
        logger.warn({ jobId }, "Job completion watch timed out")
        if (opts.onTimeout) {
          try {
            await opts.onTimeout()
          } catch (err) {
            logger.warn({ err, jobId }, "Failed to send timeout message to chat")
          }
        }
        return
      }

      try {
        const row = await db
          .selectFrom("job")
          .select(["status", "result", "error", "completed_at"])
          .where("id", "=", jobId)
          .executeTakeFirst()

        if (!row) {
          clearInterval(timer)
          return
        }

        // Only treat FAILED as terminal when completed_at is set.
        // During retries the job transitions FAILED → RETRYING → SCHEDULED
        // without setting completed_at; catching that transient state would
        // fire the callback prematurely and leave the final outcome unrelayed.
        if (row.status === "FAILED" && !row.completed_at) {
          return
        }

        if (TERMINAL_STATUSES.has(row.status)) {
          clearInterval(timer)
          try {
            await onComplete(row.result, row.status, row.error)
          } catch (err) {
            logger.warn({ err, jobId }, "Failed to relay job completion to chat")
          }
        }
      } catch {
        // Swallow DB errors — will retry on next interval
      }
    })()
  }, intervalMs)
}

/**
 * Load the last N conversation messages for a session, ordered chronologically.
 */
export async function loadConversationHistory(
  db: Kysely<Database>,
  sessionId: string,
  limit: number = MAX_HISTORY_MESSAGES,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await db
    .selectFrom("session_message")
    .select(["role", "content"])
    .where("session_id", "=", sessionId)
    .where("role", "in", ["user", "assistant"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute()

  // Reverse so oldest messages come first (chronological order)
  // Exclude the very last user message since it's the current prompt
  const chronological = rows.reverse()
  const last = chronological[chronological.length - 1]
  if (last && last.role === "user") {
    chronological.pop()
  }

  return chronological as Array<{ role: "user" | "assistant"; content: string }>
}

async function findOrCreateSession(
  db: Kysely<Database>,
  agentId: string,
  userAccountId: string,
  channelId?: string,
): Promise<{ id: string }> {
  // Try to find existing active session scoped by channel
  let query = db
    .selectFrom("session")
    .select("id")
    .where("agent_id", "=", agentId)
    .where("user_account_id", "=", userAccountId)
    .where("status", "=", "active")

  if (channelId) {
    query = query.where("channel_id", "=", channelId)
  }

  const existing = await query.executeTakeFirst()

  if (existing) return existing

  // Create a new session
  const created = await db
    .insertInto("session")
    .values({
      agent_id: agentId,
      user_account_id: userAccountId,
      channel_id: channelId ?? null,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return created
}
