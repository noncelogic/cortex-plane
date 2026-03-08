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

import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightResult {
  ok: boolean
  /** User-facing message explaining *why* the agent cannot run and *what to do*. */
  userMessage?: string
  /** Machine-readable code for programmatic callers (REST API). */
  code?: "agent_not_active" | "no_llm_credential"
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
    .select(["id", "status"])
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
  // Check env var first (cheapest path).
  if (process.env.LLM_API_KEY) {
    return { ok: true }
  }

  // Check for a bound, active LLM credential.
  const binding = await db
    .selectFrom("agent_credential_binding")
    .innerJoin(
      "provider_credential",
      "provider_credential.id",
      "agent_credential_binding.provider_credential_id",
    )
    .select(["provider_credential.id"])
    .where("agent_credential_binding.agent_id", "=", agentId)
    .where("provider_credential.credential_class", "=", "llm_provider")
    .where("provider_credential.status", "=", "active")
    .executeTakeFirst()

  if (!binding) {
    return {
      ok: false,
      userMessage: NO_CREDENTIAL_MESSAGE,
      code: "no_llm_credential",
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Job error → user message mapping
// ---------------------------------------------------------------------------

/**
 * Map a job error object (from the `error` JSONB column) to an actionable
 * user-facing message.  Falls back to a generic message when the error
 * category is not recognised.
 */
export function mapJobErrorToUserMessage(
  error: Record<string, unknown> | null | undefined,
): string {
  if (!error) {
    return "Something went wrong processing your message. Please try again."
  }

  const category = typeof error.category === "string" ? error.category : ""
  const message = typeof error.message === "string" ? error.message : ""

  // Quarantine
  if (category === "QUARANTINED" || message.includes("QUARANTINED")) {
    return (
      "This agent has been quarantined due to repeated failures. " +
      "An operator can reset it from the agent dashboard."
    )
  }

  // Missing credential
  if (
    message.includes("No LLM credential") ||
    message.includes("credential") ||
    message.includes("LLM_API_KEY")
  ) {
    return (
      "This agent does not have an LLM API key configured. " +
      "An operator needs to bind an LLM credential in the agent settings."
    )
  }

  // Authentication failure (e.g. expired/revoked API key)
  if (category === "PERMANENT" && message.includes("Authentication")) {
    return (
      "The agent's LLM API key is invalid or expired. " +
      "An operator needs to update the credential in the agent settings."
    )
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

  // Generic fallback
  return "Something went wrong processing your message. Please try again."
}
