/**
 * Centralized lifecycle defaults and config resolvers.
 *
 * Keeps default values and JSONB-to-config resolution logic in one place
 * so that both the `AgentCircuitBreaker` class and the `agent-execute`
 * task can share a single source of truth.
 */

import type { AgentCircuitBreakerConfig } from "./agent-circuit-breaker.js"

// ---------------------------------------------------------------------------
// Circuit breaker defaults
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG: AgentCircuitBreakerConfig = {
  maxConsecutiveFailures: 3,
  maxToolErrorsPerJob: 10,
  maxLlmRetriesPerJob: 5,
  tokenBudgetPerJob: 500_000,
  tokenBudgetPerSession: 2_000_000,
  toolCallRateLimit: { maxCalls: 50, windowSeconds: 300 },
  llmCallRateLimit: { maxCalls: 20, windowSeconds: 300 },
}

// ---------------------------------------------------------------------------
// Config resolver
// ---------------------------------------------------------------------------

/**
 * Extract a partial `AgentCircuitBreakerConfig` from an agent's
 * `resource_limits` JSONB column. Returns `undefined` when no
 * circuit-breaker override is present (→ fall back to defaults).
 */
export function resolveCircuitBreakerConfig(
  resourceLimits: Record<string, unknown>,
): Partial<AgentCircuitBreakerConfig> | undefined {
  const raw = resourceLimits.circuitBreaker
  return typeof raw === "object" && raw !== null
    ? (raw as Partial<AgentCircuitBreakerConfig>)
    : undefined
}
