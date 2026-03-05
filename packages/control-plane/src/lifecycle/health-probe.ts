/**
 * Agent health probe service.
 *
 * Checks multiple subsystems and produces a composite health report
 * for a single agent. Results feed into:
 * - DEGRADED lifecycle transitions
 * - Dashboard status cards
 * - GET /agents/:agentId/health API responses
 *
 * Probe schedule:
 * - Every 60s for EXECUTING agents
 * - Every 300s for READY (idle) agents
 * - Skip QUARANTINED, TERMINATED, SAFE_MODE
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { McpHealthSupervisor } from "../mcp/health-supervisor.js"
import type { HeartbeatReceiver } from "./health.js"
import type { QdrantClient } from "./hydration.js"
import type { AgentLifecycleState } from "./state-machine.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Probe interval for EXECUTING agents (60 seconds). */
export const PROBE_INTERVAL_EXECUTING_MS = 60_000

/** Probe interval for READY (idle) agents (300 seconds). */
export const PROBE_INTERVAL_READY_MS = 300_000

/** States that should be skipped during probing. */
export const SKIP_PROBE_STATES: ReadonlySet<string> = new Set([
  "QUARANTINED",
  "TERMINATED",
  "SAFE_MODE",
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OverallHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN"
export type SubsystemStatus = "OK" | "DEGRADED" | "UNAVAILABLE"

export interface HealthProbeResult {
  agentId: string
  lifecycleState: AgentLifecycleState
  healthStatus: OverallHealthStatus
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
  qdrantClient?: QdrantClient
  mcpHealthSupervisor?: McpHealthSupervisor
}

// ---------------------------------------------------------------------------
// Probe function
// ---------------------------------------------------------------------------

/**
 * Probe the health of a single agent across all subsystems.
 */
export async function probeAgentHealth(
  agentId: string,
  lifecycleState: AgentLifecycleState,
  deps: HealthProbeDeps,
): Promise<HealthProbeResult> {
  const { db, heartbeatReceiver, qdrantClient, mcpHealthSupervisor } = deps

  // 1. Heartbeat freshness
  const healthRecord = heartbeatReceiver.getHealth(agentId)
  const lastHeartbeat = healthRecord?.lastHeartbeat?.toISOString() ?? null

  // 2. Last job + checkpoint + token usage from DB
  const { lastCheckpoint, tokenBudget, dbStatus } = await probeDb(agentId, db)

  // 3. Memory subsystem reachability (Qdrant)
  const qdrantStatus = await probeQdrant(qdrantClient)

  // 4. MCP subsystem status
  const mcpStatus = probeMcp(mcpHealthSupervisor)

  // 5. Circuit breaker state (derived from heartbeat + lifecycle)
  const circuitBreaker = deriveCircuitBreakerState(healthRecord, lifecycleState)

  // 6. Derive overall health
  const subsystems = {
    qdrant: qdrantStatus,
    db: dbStatus,
    mcp: mcpStatus,
  }
  const healthStatus = deriveOverallHealth(subsystems, circuitBreaker.tripped, healthRecord)

  return {
    agentId,
    lifecycleState,
    healthStatus,
    circuitBreaker,
    lastHeartbeat,
    lastCheckpoint,
    tokenBudget,
    subsystems,
  }
}

// ---------------------------------------------------------------------------
// Subsystem probes
// ---------------------------------------------------------------------------

async function probeDb(
  agentId: string,
  db: Kysely<Database>,
): Promise<{
  lastCheckpoint: string | null
  tokenBudget: HealthProbeResult["tokenBudget"]
  dbStatus: SubsystemStatus
}> {
  try {
    const [latestJob, agent] = await Promise.all([
      db
        .selectFrom("job")
        .select(["updated_at", "payload"])
        .where("agent_id", "=", agentId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst(),
      db
        .selectFrom("agent")
        .select(["resource_limits"])
        .where("id", "=", agentId)
        .executeTakeFirst(),
    ])

    const resourceLimits = agent?.resource_limits ?? {}
    const jobPayload = (latestJob?.payload ?? {}) as Record<string, unknown>

    const tokenBudget: HealthProbeResult["tokenBudget"] = {
      usedThisJob: typeof jobPayload.tokens_used === "number" ? jobPayload.tokens_used : 0,
      usedThisSession:
        typeof jobPayload.session_tokens_used === "number" ? jobPayload.session_tokens_used : 0,
      limitPerJob:
        typeof resourceLimits.maxTokensPerJob === "number" ? resourceLimits.maxTokensPerJob : 0,
      limitPerSession:
        typeof resourceLimits.maxTokensPerSession === "number"
          ? resourceLimits.maxTokensPerSession
          : 0,
    }

    const lastCheckpoint = latestJob?.updated_at
      ? new Date(latestJob.updated_at as string | number | Date).toISOString()
      : null

    return { lastCheckpoint, tokenBudget, dbStatus: "OK" }
  } catch {
    return {
      lastCheckpoint: null,
      tokenBudget: { usedThisJob: 0, usedThisSession: 0, limitPerJob: 0, limitPerSession: 0 },
      dbStatus: "UNAVAILABLE",
    }
  }
}

async function probeQdrant(client?: QdrantClient): Promise<SubsystemStatus> {
  if (!client) return "UNAVAILABLE"

  try {
    await client.search("_health_check", "", 1)
    return "OK"
  } catch {
    return "UNAVAILABLE"
  }
}

function probeMcp(supervisor?: McpHealthSupervisor): SubsystemStatus {
  if (!supervisor) return "UNAVAILABLE"

  const report = supervisor.getHealthReport()
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
// Derivation helpers
// ---------------------------------------------------------------------------

function deriveCircuitBreakerState(
  healthRecord: ReturnType<HeartbeatReceiver["getHealth"]>,
  lifecycleState: AgentLifecycleState,
): HealthProbeResult["circuitBreaker"] {
  const consecutiveFailures = healthRecord?.consecutiveMisses ?? 0
  const tripped = consecutiveFailures >= 3 || lifecycleState === "TERMINATED"
  const tripReason = tripped
    ? consecutiveFailures >= 3
      ? `${consecutiveFailures} consecutive heartbeat misses`
      : "Agent terminated"
    : null

  return {
    state: tripped ? "OPEN" : "CLOSED",
    consecutiveFailures,
    tripped,
    tripReason,
  }
}

function deriveOverallHealth(
  subsystems: HealthProbeResult["subsystems"],
  cbTripped: boolean,
  healthRecord: ReturnType<HeartbeatReceiver["getHealth"]>,
): OverallHealthStatus {
  if (cbTripped) return "UNHEALTHY"
  if (healthRecord?.healthStatus === "UNHEALTHY") return "UNHEALTHY"

  const statuses = Object.values(subsystems)
  if (statuses.some((s) => s === "UNAVAILABLE")) return "DEGRADED"
  if (statuses.some((s) => s === "DEGRADED")) return "DEGRADED"
  if (healthRecord?.healthStatus === "WARNING") return "DEGRADED"

  if (!healthRecord) return "UNKNOWN"

  return "HEALTHY"
}

// ---------------------------------------------------------------------------
// Health Probe Scheduler
// ---------------------------------------------------------------------------

interface SchedulerEntry {
  agentId: string
  timer: ReturnType<typeof setInterval>
  lastResult: HealthProbeResult | null
}

export interface HealthProbeSchedulerDeps extends HealthProbeDeps {
  getAgentState: (agentId: string) => AgentLifecycleState | undefined
}

/**
 * Schedules periodic health probes for managed agents.
 *
 * - EXECUTING agents: probed every 60 seconds
 * - READY agents: probed every 300 seconds
 * - QUARANTINED, TERMINATED, SAFE_MODE: skipped
 */
export class HealthProbeScheduler {
  private readonly entries = new Map<string, SchedulerEntry>()
  private readonly deps: HealthProbeSchedulerDeps
  private readonly onDegraded?: (agentId: string, result: HealthProbeResult) => void

  constructor(
    deps: HealthProbeSchedulerDeps,
    onDegraded?: (agentId: string, result: HealthProbeResult) => void,
  ) {
    this.deps = deps
    this.onDegraded = onDegraded
  }

  /**
   * Start probing for an agent. Determines interval from lifecycle state.
   */
  startProbing(agentId: string): void {
    this.stopProbing(agentId)

    const state = this.deps.getAgentState(agentId)
    if (!state || SKIP_PROBE_STATES.has(state)) return

    const intervalMs = state === "EXECUTING" ? PROBE_INTERVAL_EXECUTING_MS : PROBE_INTERVAL_READY_MS

    const entry: SchedulerEntry = {
      agentId,
      timer: setInterval(() => void this.runProbe(agentId), intervalMs),
      lastResult: null,
    }
    this.entries.set(agentId, entry)

    // Run an initial probe immediately
    void this.runProbe(agentId)
  }

  /**
   * Stop probing for an agent.
   */
  stopProbing(agentId: string): void {
    const entry = this.entries.get(agentId)
    if (entry) {
      clearInterval(entry.timer)
      this.entries.delete(agentId)
    }
  }

  /**
   * Get the latest probe result for an agent.
   */
  getLastResult(agentId: string): HealthProbeResult | null {
    return this.entries.get(agentId)?.lastResult ?? null
  }

  /**
   * Shut down all probe timers.
   */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      clearInterval(entry.timer)
    }
    this.entries.clear()
  }

  private async runProbe(agentId: string): Promise<void> {
    const state = this.deps.getAgentState(agentId)
    if (!state || SKIP_PROBE_STATES.has(state)) {
      this.stopProbing(agentId)
      return
    }

    try {
      const result = await probeAgentHealth(agentId, state, this.deps)
      const entry = this.entries.get(agentId)
      if (entry) {
        entry.lastResult = result
      }

      if (result.healthStatus === "DEGRADED" && this.onDegraded) {
        this.onDegraded(agentId, result)
      }
    } catch {
      // Probe failure is non-fatal
    }
  }
}
