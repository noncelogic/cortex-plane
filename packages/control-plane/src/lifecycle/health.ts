/**
 * Agent health monitoring.
 *
 * - SSE heartbeat receiver: tracks heartbeats from agent pods
 * - Heartbeat timeout: 45 seconds (3 missed 15s heartbeats) → mark unhealthy
 * - CrashLoopBackOff mitigation: exponential cooldown (1min, 2min, 4min, 8min, max 15min)
 * - Liveness/readiness integration with K8s probes
 */

import type { AgentLifecycleState } from "./state-machine.js"

/** SSE heartbeat interval expected from agents (15 seconds). */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Number of missed heartbeats before declaring unhealthy. */
export const MISSED_HEARTBEATS_THRESHOLD = 3

/** Heartbeat timeout: 45 seconds (3 × 15s). */
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_THRESHOLD

export type AgentHealthStatus = "HEALTHY" | "WARNING" | "UNHEALTHY" | "UNKNOWN"

export interface AgentHeartbeat {
  type: "heartbeat"
  timestamp: string
  agentId: string
  jobId: string
  podName: string
  lifecycleState: AgentLifecycleState
  currentStep: number | null
  metrics: {
    heapUsedMb: number
    uptimeSeconds: number
    stepsCompleted: number
    llmCallsTotal: number
    toolCallsTotal: number
  }
}

export interface AgentHealthRecord {
  agentId: string
  lastHeartbeat: Date | null
  lastLifecycleState: AgentLifecycleState | null
  healthStatus: AgentHealthStatus
  consecutiveMisses: number
  lastMetrics: AgentHeartbeat["metrics"] | null
}

/**
 * Tracks SSE heartbeats from agent pods and determines health status.
 * The control plane instantiates one HeartbeatReceiver and feeds it
 * heartbeats from the SSE connections.
 */
export class HeartbeatReceiver {
  private readonly agents = new Map<string, AgentHealthRecord>()
  private checkInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Record a heartbeat from an agent.
   */
  recordHeartbeat(heartbeat: AgentHeartbeat): void {
    this.agents.set(heartbeat.agentId, {
      agentId: heartbeat.agentId,
      lastHeartbeat: new Date(heartbeat.timestamp),
      lastLifecycleState: heartbeat.lifecycleState,
      healthStatus: "HEALTHY",
      consecutiveMisses: 0,
      lastMetrics: heartbeat.metrics,
    })
  }

  /**
   * Evaluate health of all tracked agents based on heartbeat freshness.
   * Should be called periodically (e.g., every 15 seconds).
   */
  evaluateHealth(now: Date = new Date()): AgentHealthRecord[] {
    const unhealthy: AgentHealthRecord[] = []

    for (const record of this.agents.values()) {
      if (!record.lastHeartbeat) {
        record.healthStatus = "UNKNOWN"
        continue
      }

      const elapsed = now.getTime() - record.lastHeartbeat.getTime()

      if (elapsed <= HEARTBEAT_INTERVAL_MS) {
        record.healthStatus = "HEALTHY"
        record.consecutiveMisses = 0
      } else if (elapsed <= HEARTBEAT_INTERVAL_MS * 2) {
        record.healthStatus = "WARNING"
        record.consecutiveMisses = 1
      } else if (elapsed <= HEARTBEAT_TIMEOUT_MS) {
        record.healthStatus = "WARNING"
        record.consecutiveMisses = 2
      } else {
        record.healthStatus = "UNHEALTHY"
        record.consecutiveMisses = Math.floor(elapsed / HEARTBEAT_INTERVAL_MS)
        unhealthy.push(record)
      }
    }

    return unhealthy
  }

  /**
   * Start periodic health evaluation. Returns unhealthy agents via callback.
   */
  startMonitoring(onUnhealthy: (agents: AgentHealthRecord[]) => void): void {
    this.checkInterval = setInterval(() => {
      const unhealthy = this.evaluateHealth()
      if (unhealthy.length > 0) {
        onUnhealthy(unhealthy)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  getHealth(agentId: string): AgentHealthRecord | undefined {
    return this.agents.get(agentId)
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId)
  }

  /** All tracked agents and their health status. */
  getAllHealth(): AgentHealthRecord[] {
    return Array.from(this.agents.values())
  }
}

// ---------------------------------------------------------------------------
// CrashLoopBackOff mitigation
// ---------------------------------------------------------------------------

/**
 * Crash loop cooldown configuration.
 * Exponential backoff: 1min, 2min, 4min, 8min, max 15min.
 */
export const CRASH_COOLDOWN = {
  baseMs: 60_000,
  multiplier: 2,
  maxMs: 15 * 60_000,
} as const

/**
 * Calculate the cooldown duration before retrying a crashed agent.
 *
 * @param consecutiveCrashes - Number of consecutive crashes (1-based)
 * @returns Cooldown in milliseconds
 */
export function calculateCrashCooldown(consecutiveCrashes: number): number {
  if (consecutiveCrashes <= 0) return 0
  const delay = CRASH_COOLDOWN.baseMs * Math.pow(CRASH_COOLDOWN.multiplier, consecutiveCrashes - 1)
  return Math.min(delay, CRASH_COOLDOWN.maxMs)
}

export interface CrashRecord {
  agentId: string
  crashCount: number
  lastCrashAt: Date
  cooldownUntil: Date
}

/**
 * Tracks crash history per agent and determines whether recovery
 * should be attempted or delayed.
 */
export class CrashLoopDetector {
  private readonly crashes = new Map<string, CrashRecord>()

  /** Window within which crashes are counted as consecutive. */
  private readonly windowMs: number

  constructor(windowMs: number = 30 * 60_000) {
    this.windowMs = windowMs
  }

  /**
   * Record a crash for an agent. Returns the cooldown period before
   * recovery should be attempted.
   */
  recordCrash(agentId: string, now: Date = new Date()): CrashRecord {
    const existing = this.crashes.get(agentId)

    let crashCount: number
    if (existing && now.getTime() - existing.lastCrashAt.getTime() < this.windowMs) {
      crashCount = existing.crashCount + 1
    } else {
      crashCount = 1
    }

    const cooldownMs = calculateCrashCooldown(crashCount)
    const record: CrashRecord = {
      agentId,
      crashCount,
      lastCrashAt: now,
      cooldownUntil: new Date(now.getTime() + cooldownMs),
    }

    this.crashes.set(agentId, record)
    return record
  }

  /**
   * Check whether an agent is currently in cooldown.
   */
  isInCooldown(agentId: string, now: Date = new Date()): boolean {
    const record = this.crashes.get(agentId)
    if (!record) return false
    return now.getTime() < record.cooldownUntil.getTime()
  }

  /**
   * Get crash record for an agent.
   */
  getCrashRecord(agentId: string): CrashRecord | undefined {
    return this.crashes.get(agentId)
  }

  /**
   * Reset crash counter (e.g., after a successful recovery).
   */
  resetCrashes(agentId: string): void {
    this.crashes.delete(agentId)
  }
}

// ---------------------------------------------------------------------------
// K8s probe helpers
// ---------------------------------------------------------------------------

/**
 * States where readiness probes should return 200.
 * Only READY and EXECUTING agents are ready to serve.
 */
export const READY_STATES: ReadonlySet<AgentLifecycleState> = new Set(["READY", "EXECUTING"])

/**
 * States where liveness probes should return 200.
 * Everything except TERMINATED is considered alive.
 */
export function isLivenessHealthy(state: AgentLifecycleState): boolean {
  return state !== "TERMINATED"
}

/**
 * Determine if a lifecycle state indicates readiness.
 */
export function isReadinessHealthy(state: AgentLifecycleState): boolean {
  return READY_STATES.has(state)
}
