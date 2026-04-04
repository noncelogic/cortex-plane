/**
 * Preflight checks for agent message dispatch.
 *
 * Runs lightweight checks **before** creating a job row so that users get
 * immediate, actionable feedback instead of a generic "Something went wrong"
 * after the job fails asynchronously in the worker.
 *
 * Checks:
 * 1. Agent status must be ACTIVE (not QUARANTINED / DISABLED / ARCHIVED).
 * 2. An LLM credential must be available — either via agent_credential_binding
 *    or the LLM_API_KEY environment variable.
 */

import type { Kysely } from "kysely"

import { loadActiveLlmBindings, resolveProviderModelContract } from "../chat/runtime-contract.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean
  /** User-facing message explaining *why* the agent cannot run and *what to do*. */
  userMessage?: string
  /** Machine-readable code for programmatic callers (REST API). */
  code?: "agent_not_active" | "no_llm_credential" | "provider_model_misconfigured"
  diagnostics?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// User-facing messages
// ---------------------------------------------------------------------------

const STATUS_MESSAGES: Record<string, string> = {
  QUARANTINED:
    "This agent is temporarily quarantined due to repeated failures. " +
    "An operator can reset it from the agent dashboard.",
  DISABLED:
    "This agent has been disabled by an operator. " + "Contact your administrator to re-enable it.",
  ARCHIVED: "This agent has been archived and is no longer accepting messages.",
}

const NO_CREDENTIAL_MESSAGE =
  "This agent does not have an LLM API key configured. " +
  "An operator needs to bind an LLM credential in the agent settings."

function providerModelMismatchMessage(details: {
  provider?: string | null
  model?: string | null
  fallback?: string | null
}): string {
  const summary = [details.provider, details.model].filter(Boolean).join(" / ")
  if (summary) {
    return (
      `This agent is configured for ${summary}, but that provider/model is not currently ` +
      "bound and available. An operator needs to fix the agent's provider or model binding."
    )
  }
  return (
    details.fallback ??
    "This agent's configured provider/model is not currently bound and available. " +
      "An operator needs to fix the agent's provider or model binding."
  )
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Run preflight checks for an agent before dispatching a job.
 *
 * Returns `{ ok: true }` when the agent is ready, or `{ ok: false, ... }`
 * with an actionable user message when a precondition is not met.
 */
export async function runPreflight(
  db: Kysely<Database>,
  agentId: string,
): Promise<PreflightResult> {
  // ── 1. Agent status ─────────────────────────────────────────────────
  const agent = await db
    .selectFrom("agent")
    .select(["id", "status", "model_config"])
    .where("id", "=", agentId)
    .executeTakeFirst()

  if (!agent) {
    return { ok: false, userMessage: "Agent not found.", code: "agent_not_active" }
  }

  if (agent.status !== "ACTIVE") {
    return {
      ok: false,
      userMessage:
        STATUS_MESSAGES[agent.status] ?? `Agent is ${agent.status}, cannot accept messages.`,
      code: "agent_not_active",
    }
  }

  // ── 2. LLM credential availability ─────────────────────────────────
  const requestedProvider =
    typeof agent.model_config?.provider === "string"
      ? agent.model_config.provider
      : typeof agent.model_config?.providerId === "string"
        ? agent.model_config.providerId
        : null
  const requestedModel =
    typeof agent.model_config?.model === "string" ? agent.model_config.model : null

  if (process.env.LLM_API_KEY && requestedProvider === null && requestedModel === null) {
    return {
      ok: true,
      diagnostics: {
        providerModel: {
          requestedProvider: null,
          requestedModel: null,
          resolvedProvider: null,
          resolvedModel: null,
          boundProviders: [],
          bindingRequired: false,
          mismatchCode: null,
          mismatchMessage: null,
        },
      },
    }
  }

  const bindings = await loadActiveLlmBindings(db, agentId)
  const providerModel = resolveProviderModelContract(agent.model_config, bindings)

  if (providerModel.mismatchCode) {
    return {
      ok: false,
      userMessage: providerModelMismatchMessage({
        provider: providerModel.resolvedProvider ?? providerModel.requestedProvider,
        model: providerModel.resolvedModel ?? providerModel.requestedModel,
        fallback: providerModel.mismatchMessage,
      }),
      code: "provider_model_misconfigured",
      diagnostics: {
        providerModel,
      },
    }
  }

  if (bindings.length === 0) {
    return {
      ok: false,
      userMessage: NO_CREDENTIAL_MESSAGE,
      code: "no_llm_credential",
      diagnostics: {
        providerModel,
      },
    }
  }

  return {
    ok: true,
    diagnostics: {
      providerModel,
    },
  }
}

// ---------------------------------------------------------------------------
// Job error → user message mapping
// ---------------------------------------------------------------------------

/**
 * Map a job error object (from the `error` JSONB column or the execution
 * `result` JSONB column) to an actionable user-facing message.
 *
 * The function inspects both the top-level `category`/`message` fields
 * (set by the catch-block error path) and the nested `error.classification`
 * field (set by the execution-result path via `executionResultToJson`).
 *
 * Falls back to a generic message when the error category is not recognised.
 */
export function mapJobErrorToUserMessage(
  error: Record<string, unknown> | null | undefined,
): string {
  if (!error) {
    return "Something went wrong processing your message. Please try again."
  }

  // Top-level fields from the job `error` column (exception path)
  const category = typeof error.category === "string" ? error.category : ""
  const code = typeof error.code === "string" ? error.code : ""
  const message = typeof error.message === "string" ? error.message : ""
  const provider = typeof error.provider === "string" ? error.provider : ""
  const model = typeof error.model === "string" ? error.model : ""

  // Nested error from the execution `result` column (execution-result path)
  const nested = error.error as Record<string, unknown> | undefined
  const nestedCode = typeof nested?.code === "string" ? nested.code : ""
  const nestedClassification =
    typeof nested?.classification === "string" ? nested.classification : ""
  const nestedMessage = typeof nested?.message === "string" ? nested.message : ""
  const nestedProvider = typeof nested?.provider === "string" ? nested.provider : ""
  const nestedModel = typeof nested?.model === "string" ? nested.model : ""

  // Combine for matching
  const allMessages = [message, nestedMessage].join(" ")
  const resolvedProvider = provider || nestedProvider
  const resolvedModel = model || nestedModel

  if (code === "model_unavailable" || nestedCode === "model_unavailable") {
    const details = [resolvedModel, resolvedProvider].filter(Boolean).join(" / ")
    return details
      ? `The configured AI model is unavailable for this provider (${details}). An operator needs to update the agent's model configuration.`
      : "The configured AI model is unavailable for this provider. An operator needs to update the agent's model configuration."
  }

  const resourceCode = code || nestedCode
  if (resourceCode === "rate_limit") {
    return "The AI provider is currently rate-limiting requests. Please try again in a few minutes."
  }
  if (resourceCode === "quota_exceeded") {
    return "The AI provider quota has been exceeded. An operator needs to increase quota or switch credentials."
  }
  if (resourceCode === "upstream_cancelled") {
    return "The AI request was cancelled by the upstream provider. Please try again."
  }
  if (resourceCode === "resource_guard") {
    return (
      "Execution was stopped by a local resource safety guard (budget/rate limits). " +
      "Please retry with a smaller request or ask an operator to adjust limits."
    )
  }
  if (resourceCode === "timeout") {
    return "The request timed out. Please try again."
  }

  // Quarantine
  if (category === "QUARANTINED" || allMessages.includes("QUARANTINED")) {
    return (
      "This agent has been quarantined due to repeated failures. " +
      "An operator can reset it from the agent dashboard."
    )
  }

  // Missing credential
  if (
    allMessages.includes("No LLM credential") ||
    allMessages.includes("credential") ||
    allMessages.includes("LLM_API_KEY")
  ) {
    return (
      "This agent does not have an LLM API key configured. " +
      "An operator needs to bind an LLM credential in the agent settings."
    )
  }

  // Authentication / authorization failure (e.g. expired/revoked API key, 401/403)
  if (
    (category === "PERMANENT" || nestedClassification === "permanent") &&
    (allMessages.includes("Authentication") ||
      allMessages.includes("authorization") ||
      allMessages.includes("403") ||
      allMessages.includes("401") ||
      allMessages.includes("Forbidden") ||
      allMessages.includes("Unauthorized"))
  ) {
    return (
      "The agent's LLM API key is invalid or expired. " +
      "An operator needs to update the credential in the agent settings."
    )
  }

  // Provider not found / model not available (404)
  if (
    allMessages.includes("404") ||
    allMessages.includes("Not Found") ||
    allMessages.includes("model not found") ||
    allMessages.includes("does not exist")
  ) {
    return (
      "The configured AI model or provider endpoint was not found. " +
      "An operator needs to check the agent's model configuration."
    )
  }

  // Rate limiting (429)
  if (
    allMessages.includes("429") ||
    allMessages.includes("rate limit") ||
    allMessages.includes("Rate limit") ||
    allMessages.includes("Too Many Requests") ||
    allMessages.includes("quota")
  ) {
    return "The AI provider is currently rate-limiting requests. Please try again in a few minutes."
  }

  // Context budget exceeded
  if (category === "CONTEXT_BUDGET_EXCEEDED") {
    return (
      "The message exceeded the agent's context size limit. " +
      "Try a shorter message or ask an operator to increase the budget."
    )
  }

  // Timeout
  if (category === "TIMEOUT") {
    return "The request timed out. Please try again."
  }

  // Provider unavailable (500/502/503)
  if (
    allMessages.includes("500") ||
    allMessages.includes("502") ||
    allMessages.includes("503") ||
    allMessages.includes("Service Unavailable") ||
    allMessages.includes("Internal Server Error")
  ) {
    return "The AI provider is temporarily unavailable. Please try again shortly."
  }

  // Generic fallback
  return "Something went wrong processing your message. Please try again."
}
