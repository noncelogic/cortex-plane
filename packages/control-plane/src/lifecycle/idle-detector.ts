/**
 * Scale-to-zero idle detection.
 *
 * Tracks last activity per agent and triggers graceful termination
 * after a configurable idle timeout (default: 30 minutes).
 *
 * Activity types:
 * - Job completion
 * - Incoming message / heartbeat
 * - Any state transition except to TERMINATED
 *
 * When idle timeout fires, the agent is gracefully drained, freeing
 * cluster resources. On new work, a cold start re-boots from checkpoint.
 */

/** Default idle timeout: 30 minutes. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000

export interface IdleDetectorOptions {
  /** Idle timeout in milliseconds. Default: 30 minutes. */
  idleTimeoutMs?: number
  /** Callback invoked when an agent becomes idle. */
  onIdle: (agentId: string) => void
}

interface AgentActivity {
  agentId: string
  lastActivityAt: Date
  timer: ReturnType<typeof setTimeout>
}

/**
 * Monitors agent activity and fires a callback when an agent has been
 * idle for longer than the configured timeout.
 */
export class IdleDetector {
  private readonly agents = new Map<string, AgentActivity>()
  private readonly idleTimeoutMs: number
  private readonly onIdle: (agentId: string) => void

  constructor(options: IdleDetectorOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.onIdle = options.onIdle
  }

  /**
   * Record activity for an agent, resetting the idle timer.
   */
  recordActivity(agentId: string, now: Date = new Date()): void {
    const existing = this.agents.get(agentId)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      this.agents.delete(agentId)
      this.onIdle(agentId)
    }, this.idleTimeoutMs)

    this.agents.set(agentId, {
      agentId,
      lastActivityAt: now,
      timer,
    })
  }

  /**
   * Get the last activity timestamp for an agent.
   */
  getLastActivity(agentId: string): Date | undefined {
    return this.agents.get(agentId)?.lastActivityAt
  }

  /**
   * Calculate how long until an agent's idle timeout fires.
   * Returns 0 if the agent is not tracked or already timed out.
   */
  timeUntilIdle(agentId: string, now: Date = new Date()): number {
    const activity = this.agents.get(agentId)
    if (!activity) return 0

    const elapsed = now.getTime() - activity.lastActivityAt.getTime()
    return Math.max(0, this.idleTimeoutMs - elapsed)
  }

  /**
   * Remove an agent from tracking (e.g., after termination).
   */
  removeAgent(agentId: string): void {
    const existing = this.agents.get(agentId)
    if (existing) {
      clearTimeout(existing.timer)
      this.agents.delete(agentId)
    }
  }

  /**
   * Stop tracking all agents and clear all timers.
   */
  shutdown(): void {
    for (const activity of this.agents.values()) {
      clearTimeout(activity.timer)
    }
    this.agents.clear()
  }

  /** Number of agents currently being tracked. */
  get trackedCount(): number {
    return this.agents.size
  }
}
