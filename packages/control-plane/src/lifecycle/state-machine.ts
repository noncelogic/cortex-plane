/**
 * Agent lifecycle state machine.
 *
 * Defines the lifecycle states of an agent pod and enforces
 * valid transitions between them. Modeled after the job state machine
 * (spike #24) but for the ephemeral pod process, not the durable job.
 *
 * Core states (happy path):
 * - BOOTING: container started, loading config, establishing DB connection
 * - HYDRATING: loading checkpoint, Qdrant context, JSONL buffer
 * - READY: hydration complete, probes pass, SSE connected
 * - EXECUTING: actively processing job steps
 * - DRAINING: SIGTERM received, flushing state, closing connections
 * - TERMINATED: process exited
 *
 * Resilience states (#266):
 * - DEGRADED: executing with impaired subsystems (e.g. Qdrant unreachable)
 * - QUARANTINED: frozen, no new jobs, operator intervention required
 * - SAFE_MODE: booted with minimal config for debugging (no tools/memory)
 */

export type AgentLifecycleState =
  | "BOOTING"
  | "HYDRATING"
  | "READY"
  | "EXECUTING"
  | "DRAINING"
  | "TERMINATED"
  | "DEGRADED"
  | "QUARANTINED"
  | "SAFE_MODE"

/**
 * Valid state transitions for the agent lifecycle.
 * Each key maps to the set of states it can transition to.
 *
 * Resilience transitions (#266):
 * - EXECUTING → DEGRADED: subsystem failure detected
 * - EXECUTING → QUARANTINED: circuit breaker trips / operator quarantine
 * - DEGRADED → EXECUTING: subsystem recovers
 * - DEGRADED → QUARANTINED: further failures
 * - DEGRADED → DRAINING / TERMINATED: shutdown / crash
 * - QUARANTINED → DRAINING / TERMINATED: operator release / terminate
 * - SAFE_MODE → READY / TERMINATED: minimal hydration complete / fatal error
 */
export const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  BOOTING: ["HYDRATING", "TERMINATED", "SAFE_MODE"],
  HYDRATING: ["READY", "TERMINATED"],
  READY: ["EXECUTING", "DRAINING"],
  EXECUTING: ["DRAINING", "TERMINATED", "DEGRADED", "QUARANTINED"],
  DRAINING: ["TERMINATED"],
  TERMINATED: [],
  DEGRADED: ["EXECUTING", "QUARANTINED", "DRAINING", "TERMINATED"],
  QUARANTINED: ["DRAINING", "TERMINATED"],
  SAFE_MODE: ["READY", "TERMINATED"],
}

export class InvalidTransitionError extends Error {
  readonly from: AgentLifecycleState
  readonly to: AgentLifecycleState

  constructor(from: AgentLifecycleState, to: AgentLifecycleState) {
    super(`Invalid lifecycle transition: ${from} → ${to}`)
    this.name = "InvalidTransitionError"
    this.from = from
    this.to = to
  }
}

/**
 * Validate whether a state transition is allowed.
 * Returns true if the transition is valid, false otherwise.
 */
export function isValidTransition(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

/**
 * Assert that a state transition is valid. Throws InvalidTransitionError if not.
 */
export function assertValidTransition(from: AgentLifecycleState, to: AgentLifecycleState): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to)
  }
}

export interface LifecycleTransitionEvent {
  from: AgentLifecycleState
  to: AgentLifecycleState
  timestamp: Date
  agentId: string
  reason?: string
}

export type LifecycleListener = (event: LifecycleTransitionEvent) => void

/**
 * Tracks lifecycle state for an agent pod and enforces valid transitions.
 * Emits events on state changes for observability.
 */
export class AgentLifecycleStateMachine {
  private _state: AgentLifecycleState = "BOOTING"
  private readonly agentId: string
  private readonly listeners: LifecycleListener[] = []

  constructor(agentId: string) {
    this.agentId = agentId
  }

  get state(): AgentLifecycleState {
    return this._state
  }

  /**
   * Transition to a new state. Throws InvalidTransitionError if the
   * transition is not allowed by the state machine rules.
   */
  transition(to: AgentLifecycleState, reason?: string): void {
    assertValidTransition(this._state, to)
    const event: LifecycleTransitionEvent = {
      from: this._state,
      to,
      timestamp: new Date(),
      agentId: this.agentId,
      reason,
    }
    this._state = to
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  onTransition(listener: LifecycleListener): void {
    this.listeners.push(listener)
  }

  /** Check if the agent is in a state where readiness probes should return 200. */
  get isReady(): boolean {
    return this._state === "READY" || this._state === "EXECUTING" || this._state === "DEGRADED"
  }

  /** Check if the agent is in a state where liveness probes should return 200. */
  get isAlive(): boolean {
    return this._state !== "TERMINATED"
  }

  /** Check if the agent is in a terminal state. */
  get isTerminal(): boolean {
    return this._state === "TERMINATED"
  }

  /** Check if the agent is executing with impaired subsystems. */
  get isDegraded(): boolean {
    return this._state === "DEGRADED"
  }

  /** Check if the agent is frozen pending operator intervention. */
  get isQuarantined(): boolean {
    return this._state === "QUARANTINED"
  }

  /** Check if the agent is booted in safe mode (no tools/memory). */
  get isSafeMode(): boolean {
    return this._state === "SAFE_MODE"
  }
}
