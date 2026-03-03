/**
 * MCP Health Supervisor
 *
 * Periodically probes registered MCP servers to assess liveness and readiness.
 * Integrates per-server circuit breakers, updates DB status columns, and
 * broadcasts health change events over SSE.
 *
 * Probe cycle:
 *   1. Fetch all non-DISABLED servers from DB
 *   2. For each server whose interval has elapsed:
 *      a. Liveness — ping (HTTP GET to connection.url)
 *      b. Readiness — tools/list (validates tool catalog is reachable)
 *   3. Record success/failure in the server's CircuitBreaker
 *   4. Derive new McpServerStatus from circuit state
 *   5. Persist status + last_healthy_at + error_message to DB
 *   6. Broadcast SSE event on status change
 */

import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
  type CircuitStats,
} from "@cortex/shared/backends"
import type { Kysely } from "kysely"

import type { Database, McpServer, McpServerStatus } from "../db/types.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-server runtime state tracked by the supervisor. */
export interface ServerHealthState {
  serverId: string
  slug: string
  status: McpServerStatus
  circuitBreaker: CircuitBreaker
  lastProbeAt: number
  probeIntervalMs: number
  lastError: string | null
  consecutiveFailures: number
}

/** Snapshot exposed by getHealthReport(). */
export interface McpServerHealthReport {
  serverId: string
  slug: string
  status: McpServerStatus
  circuitBreaker: CircuitStats
  lastProbeAt: string | null
  lastError: string | null
  consecutiveFailures: number
}

/** Overall health summary returned by the /health/mcp route. */
export interface McpHealthSummary {
  status: "ok" | "degraded" | "unavailable"
  servers: McpServerHealthReport[]
  probeIntervalMs: number
}

/** Probe function signature — injected for testability. */
export type ProbeFn = (server: McpServer) => Promise<void>

export interface McpHealthSupervisorDeps {
  db: Kysely<Database>
  sseManager?: SSEConnectionManager
  /** Override default probe interval (ms) for all servers without a custom value. */
  defaultProbeIntervalMs?: number
  /** Circuit breaker config overrides. */
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>
  /** Custom probe function (for testing). */
  probeFn?: ProbeFn
  /** Clock function (for testing). */
  now?: () => number
}

// ---------------------------------------------------------------------------
// SSE channel + event type
// ---------------------------------------------------------------------------

const SSE_CHANNEL = "_mcp_health"
/** Cast to any SSEEventType — the manager accepts string at runtime. */
const SSE_EVENT = "mcp:health" as never

// ---------------------------------------------------------------------------
// Default circuit breaker config tuned for MCP health probing
// ---------------------------------------------------------------------------

const DEFAULT_MCP_CB_CONFIG: Partial<CircuitBreakerConfig> = {
  failureThreshold: 3,
  windowMs: 120_000,
  openDurationMs: 30_000,
  halfOpenMaxAttempts: 1,
  successThresholdToClose: 2,
}

// ---------------------------------------------------------------------------
// McpHealthSupervisor
// ---------------------------------------------------------------------------

export class McpHealthSupervisor {
  private readonly db: Kysely<Database>
  private readonly sseManager?: SSEConnectionManager
  private readonly defaultProbeIntervalMs: number
  private readonly cbConfig: Partial<CircuitBreakerConfig>
  private readonly probeFn: ProbeFn
  private readonly now: () => number

  /** serverId → runtime health state */
  private servers = new Map<string, ServerHealthState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(deps: McpHealthSupervisorDeps) {
    this.db = deps.db
    this.sseManager = deps.sseManager
    this.defaultProbeIntervalMs = deps.defaultProbeIntervalMs ?? 30_000
    this.cbConfig = { ...DEFAULT_MCP_CB_CONFIG, ...deps.circuitBreakerConfig }
    this.probeFn = deps.probeFn ?? defaultProbeFn
    this.now = deps.now ?? Date.now
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return
    this.running = true
    // Tick immediately, then on interval
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.defaultProbeIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get health reports for all tracked servers. */
  getHealthReport(): McpHealthSummary {
    const reports: McpServerHealthReport[] = []

    for (const state of this.servers.values()) {
      reports.push({
        serverId: state.serverId,
        slug: state.slug,
        status: state.status,
        circuitBreaker: state.circuitBreaker.getStats(),
        lastProbeAt: state.lastProbeAt > 0 ? new Date(state.lastProbeAt).toISOString() : null,
        lastError: state.lastError,
        consecutiveFailures: state.consecutiveFailures,
      })
    }

    const overallStatus = deriveOverallStatus(reports)

    return {
      status: overallStatus,
      servers: reports,
      probeIntervalMs: this.defaultProbeIntervalMs,
    }
  }

  /** Expose internal state for a single server (used in tests). */
  getServerState(serverId: string): ServerHealthState | undefined {
    return this.servers.get(serverId)
  }

  // -----------------------------------------------------------------------
  // Probe cycle
  // -----------------------------------------------------------------------

  /** Single tick of the supervisor loop. Exported for testing. */
  async tick(): Promise<void> {
    if (!this.running) return

    let dbServers: McpServer[]
    try {
      dbServers = await this.db
        .selectFrom("mcp_server")
        .selectAll()
        .where("status", "!=", "DISABLED")
        .execute()
    } catch {
      // DB unreachable — skip this cycle
      return
    }

    // Reconcile in-memory state with DB
    this.reconcile(dbServers)

    // Probe each server whose interval has elapsed
    const now = this.now()
    const probePromises: Promise<void>[] = []

    for (const server of dbServers) {
      const state = this.servers.get(server.id)
      if (!state) continue

      const elapsed = now - state.lastProbeAt
      if (elapsed < state.probeIntervalMs) continue

      // Skip probing if circuit is OPEN (will auto-transition via getState)
      const cbState = state.circuitBreaker.getState()
      if (cbState === "OPEN") {
        continue
      }

      probePromises.push(this.probeServer(server, state))
    }

    await Promise.allSettled(probePromises)
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /** Sync in-memory map with the DB server list. */
  private reconcile(dbServers: McpServer[]): void {
    const dbIds = new Set(dbServers.map((s) => s.id))

    // Remove servers no longer in DB
    for (const id of this.servers.keys()) {
      if (!dbIds.has(id)) this.servers.delete(id)
    }

    // Add new servers
    for (const server of dbServers) {
      if (!this.servers.has(server.id)) {
        this.servers.set(server.id, {
          serverId: server.id,
          slug: server.slug,
          status: server.status,
          circuitBreaker: new CircuitBreaker(this.cbConfig, this.now),
          lastProbeAt: 0,
          probeIntervalMs: server.health_probe_interval_ms ?? this.defaultProbeIntervalMs,
          lastError: server.error_message,
          consecutiveFailures: 0,
        })
      } else {
        // Update probe interval if changed
        const state = this.servers.get(server.id)!
        state.probeIntervalMs = server.health_probe_interval_ms ?? this.defaultProbeIntervalMs
      }
    }
  }

  /** Probe a single server: liveness + readiness. */
  private async probeServer(server: McpServer, state: ServerHealthState): Promise<void> {
    const previousStatus = state.status
    state.lastProbeAt = this.now()

    // If half-open, acquire the slot
    if (state.circuitBreaker.getState() === "HALF_OPEN") {
      state.circuitBreaker.acquireHalfOpenSlot()
    }

    try {
      await this.probeFn(server)

      // Success
      state.circuitBreaker.recordSuccess()
      state.consecutiveFailures = 0
      state.lastError = null

      const newStatus = circuitStateToMcpStatus(state.circuitBreaker.getState())
      state.status = newStatus

      await this.updateServerDb(server.id, newStatus, null, true)

      if (newStatus !== previousStatus) {
        this.broadcastChange(state, previousStatus)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      state.circuitBreaker.recordFailure("transient")
      state.consecutiveFailures++
      state.lastError = message

      const newStatus = circuitStateToMcpStatus(state.circuitBreaker.getState())
      state.status = newStatus

      await this.updateServerDb(server.id, newStatus, message, false)

      if (newStatus !== previousStatus) {
        this.broadcastChange(state, previousStatus)
      }
    }
  }

  /** Persist status changes to DB. */
  private async updateServerDb(
    serverId: string,
    status: McpServerStatus,
    errorMessage: string | null,
    healthy: boolean,
  ): Promise<void> {
    try {
      const update: Record<string, unknown> = {
        status,
        error_message: errorMessage,
        updated_at: new Date(),
      }
      if (healthy) {
        update.last_healthy_at = new Date()
      }

      await this.db.updateTable("mcp_server").set(update).where("id", "=", serverId).execute()
    } catch {
      // DB write failed — non-fatal, will retry next cycle
    }
  }

  /** Broadcast health change over SSE. */
  private broadcastChange(state: ServerHealthState, previousStatus: McpServerStatus): void {
    if (!this.sseManager) return

    this.sseManager.broadcast(SSE_CHANNEL, SSE_EVENT, {
      serverId: state.serverId,
      slug: state.slug,
      previousStatus,
      status: state.status,
      circuitBreaker: state.circuitBreaker.getStats(),
      lastError: state.lastError,
      timestamp: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map CircuitBreaker state to McpServerStatus. */
export function circuitStateToMcpStatus(state: CircuitState): McpServerStatus {
  switch (state) {
    case "CLOSED":
      return "ACTIVE"
    case "HALF_OPEN":
      return "DEGRADED"
    case "OPEN":
      return "ERROR"
  }
}

function deriveOverallStatus(reports: McpServerHealthReport[]): "ok" | "degraded" | "unavailable" {
  if (reports.length === 0) return "ok"
  const allHealthy = reports.every((r) => r.status === "ACTIVE")
  if (allHealthy) return "ok"
  const allError = reports.every((r) => r.status === "ERROR")
  if (allError) return "unavailable"
  return "degraded"
}

/**
 * Default probe function: performs an HTTP fetch to the server's connection URL.
 * For streamable-http servers, hits the URL directly.
 * This serves as both liveness (can we connect?) and readiness (does it respond?).
 */
async function defaultProbeFn(server: McpServer): Promise<void> {
  const connection = server.connection as Record<string, unknown>
  const url = connection.url as string | undefined

  if (!url) {
    throw new Error(`Server ${server.slug} has no connection URL`)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    })

    if (!response.ok && response.status !== 405) {
      throw new Error(`Probe failed: HTTP ${response.status}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}
