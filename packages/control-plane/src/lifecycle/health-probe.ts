/**
 * Agent health probe (#317 / #266-T8).
 *
 * Aggregates health signals from multiple subsystems into a single
 * HealthProbeResult that feeds the GET /agents/:agentId/health API
 * and drives DEGRADED transitions.
 *
 * Checks:
 *   1. Heartbeat freshness (HeartbeatReceiver)
 *   2. Last job completion status (DB)
 *   3. Memory subsystem reachability (Qdrant ping)
 *   4. Token budget remaining (circuit breaker state)
 *   5. Circuit breaker state
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { McpHealthSupervisor } from "../mcp/health-supervisor.js"
import type { AgentCircuitBreakerState } from "./agent-circuit-breaker.js"
import type { HeartbeatReceiver } from "./health.js"
import type { QdrantClient } from "./hydration.js"
import { healthProbeDurationSeconds } from "./metrics.js"
import type { AgentLifecycleState } from "./state-machine.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubsystemStatus = "OK" | "DEGRADED" | "UNAVAILABLE"
export type ProbeHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN"

export interface HealthProbeResult {
  agentId: string
  lifecycleState: AgentLifecycleState
  healthStatus: ProbeHealthStatus
  circuitBreaker: {
    state: string
    consecutiveFailures: number
    tripped: boolean
    tripReason: string | null
  }
  lastHeartbeat: string | null
  lastCheckpoint: string | null
  tokenBudget: {
    usedThisJob: number
    usedThisSession: number
    limitPerJob: number
    limitPerSession: number
  }
  subsystems: {
    qdrant: SubsystemStatus
    db: SubsystemStatus
    mcp: SubsystemStatus
  }
}

export interface HealthProbeDeps {
  db: Kysely<Database>
  heartbeatReceiver: HeartbeatReceiver
  circuitBreakerState?: Readonly<AgentCircuitBreakerState>
  tokenBudgetConfig?: { limitPerJob: number; limitPerSession: number }
  qdrantClient?: QdrantClient
  mcpHealthSupervisor?: McpHealthSupervisor
  lifecycleState: AgentLifecycleState
}

// ---------------------------------------------------------------------------
// Probe schedule constants
// ---------------------------------------------------------------------------

/** Probe interval for EXECUTING agents (ms). */
export const PROBE_INTERVAL_EXECUTING_MS = 60_000

/** Probe interval for READY (idle) agents (ms). */
export const PROBE_INTERVAL_READY_MS = 300_000

/** States that should be skipped during scheduled probing. */
export const PROBE_SKIP_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  "QUARANTINED",
  "TERMINATED",
  "SAFE_MODE",
])

// ---------------------------------------------------------------------------
// Subsystem checks
// ---------------------------------------------------------------------------

async function checkQdrant(qdrantClient?: QdrantClient): Promise<SubsystemStatus> {
  if (!qdrantClient) return "OK" // no Qdrant configured → not a failure
  if (!qdrantClient.getCollections) return "OK" // no health check method
  try {
    await qdrantClient.getCollections()
    return "OK"
  } catch {
    return "UNAVAILABLE"
  }
}

async function checkDb(db: Kysely<Database>): Promise<SubsystemStatus> {
  try {
    await db.selectFrom("agent").select("id").limit(1).execute()
    return "OK"
  } catch {
    return "UNAVAILABLE"
  }
}

function checkMcp(mcpHealthSupervisor?: McpHealthSupervisor): SubsystemStatus {
  if (!mcpHealthSupervisor) return "OK" // no MCP configured → not a failure
  const report = mcpHealthSupervisor.getHealthReport()
  switch (report.status) {
    case "ok":
      return "OK"
    case "degraded":
      return "DEGRADED"
    case "unavailable":
      return "UNAVAILABLE"
  }
}

// ---------------------------------------------------------------------------
// Overall health derivation
// ---------------------------------------------------------------------------

function deriveHealthStatus(
  subsystems: HealthProbeResult["subsystems"],
  cbTripped: boolean,
  lifecycleState: AgentLifecycleState,
): ProbeHealthStatus {
  // Terminal or quarantined → UNHEALTHY
  if (lifecycleState === "TERMINATED" || lifecycleState === "QUARANTINED") {
    return "UNHEALTHY"
  }

  // Circuit breaker tripped → UNHEALTHY
  if (cbTripped) {
    return "UNHEALTHY"
  }

  const statuses = Object.values(subsystems)
  const hasUnavailable = statuses.includes("UNAVAILABLE")
  const hasDegraded = statuses.includes("DEGRADED")

  if (hasUnavailable) return "DEGRADED"
  if (hasDegraded) return "DEGRADED"

  return "HEALTHY"
}

// ---------------------------------------------------------------------------
// Main probe function
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET_PER_JOB = 500_000
const DEFAULT_TOKEN_BUDGET_PER_SESSION = 2_000_000

export async function probeAgentHealth(
  agentId: string,
  deps: HealthProbeDeps,
): Promise<HealthProbeResult> {
  const start = Date.now()

  try {
    // Run subsystem checks in parallel
    const [qdrantStatus, dbStatus, lastCheckpointRow] = await Promise.all([
      checkQdrant(deps.qdrantClient),
      checkDb(deps.db),
      deps.db
        .selectFrom("agent_checkpoint")
        .select("created_at")
        .where("agent_id", "=", agentId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst()
        .catch(() => undefined),
    ])

    const mcpStatus = checkMcp(deps.mcpHealthSupervisor)

    // Heartbeat
    const healthRecord = deps.heartbeatReceiver.getHealth(agentId)
    const lastHeartbeat = healthRecord?.lastHeartbeat?.toISOString() ?? null

    // Last checkpoint
    const lastCheckpoint = lastCheckpointRow
      ? new Date(lastCheckpointRow.created_at).toISOString()
      : null

    // Circuit breaker
    const cbState = deps.circuitBreakerState ?? {
      consecutiveJobFailures: 0,
      tripped: false,
      tripReason: null,
      currentJobTokensUsed: 0,
      currentSessionTokensUsed: 0,
    }

    const tokenBudgetConfig = deps.tokenBudgetConfig ?? {
      limitPerJob: DEFAULT_TOKEN_BUDGET_PER_JOB,
      limitPerSession: DEFAULT_TOKEN_BUDGET_PER_SESSION,
    }

    const subsystems = { qdrant: qdrantStatus, db: dbStatus, mcp: mcpStatus }
    const healthStatus = deriveHealthStatus(subsystems, cbState.tripped, deps.lifecycleState)

    return {
      agentId,
      lifecycleState: deps.lifecycleState,
      healthStatus,
      circuitBreaker: {
        state: cbState.tripped ? "OPEN" : "CLOSED",
        consecutiveFailures: cbState.consecutiveJobFailures,
        tripped: cbState.tripped,
        tripReason: cbState.tripReason ?? null,
      },
      lastHeartbeat,
      lastCheckpoint,
      tokenBudget: {
        usedThisJob: cbState.currentJobTokensUsed ?? 0,
        usedThisSession: cbState.currentSessionTokensUsed ?? 0,
        limitPerJob: tokenBudgetConfig.limitPerJob,
        limitPerSession: tokenBudgetConfig.limitPerSession,
      },
      subsystems,
    }
  } finally {
    const durationS = (Date.now() - start) / 1000
    healthProbeDurationSeconds.record(durationS, { agent_id: agentId })
  }
}
