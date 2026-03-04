/**
 * Agent lifecycle state machine.
 *
 * Defines the lifecycle states of an agent pod and enforces
 * valid transitions between them. Modeled after the job state machine
 * (spike #24) but for the ephemeral pod process, not the durable job.
 *
 * States:
 * - BOOTING: container started, loading config, establishing DB connection
 * - HYDRATING: loading checkpoint, Qdrant context, JSONL buffer
 * - READY: hydration complete, probes pass, SSE connected
 * - EXECUTING: actively processing job steps
 * - DEGRADED: still serving but impaired (e.g. partial tool failures)
 * - QUARANTINED: isolated from new work, awaiting drain
 * - SAFE_MODE: restricted functionality, limited to safe operations
 * - DRAINING: SIGTERM received, flushing state, closing connections
 * - TERMINATED: process exited
 */

export type AgentLifecycleState =
  | "BOOTING"
  | "HYDRATING"
  | "READY"
  | "EXECUTING"
  | "DEGRADED"
  | "QUARANTINED"
  | "SAFE_MODE"
  | "DRAINING"
  | "TERMINATED"

/**
 * Valid state transitions for the agent lifecycle.
 * Each key maps to the set of states it can transition to.
 */
export const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  BOOTING: ["HYDRATING", "TERMINATED"],
  HYDRATING: ["READY", "TERMINATED"],
  READY: ["EXECUTING", "DRAINING"],
  EXECUTING: ["DEGRADED", "QUARANTINED", "DRAINING", "TERMINATED"],
  DEGRADED: ["EXECUTING", "QUARANTINED", "DRAINING", "TERMINATED"],
  QUARANTINED: ["DRAINING", "TERMINATED"],
  SAFE_MODE: ["READY", "TERMINATED"],
  DRAINING: ["TERMINATED"],
  TERMINATED: [],
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

  /** Check if the agent is in a degraded state (still serving, but impaired). */
  get isDegraded(): boolean {
    return this._state === "DEGRADED"
  }

  /** Check if the agent is quarantined (isolated from new work). */
  get isQuarantined(): boolean {
    return this._state === "QUARANTINED"
  }

  /** Check if the agent is in safe mode (restricted functionality). */
  get isSafeMode(): boolean {
    return this._state === "SAFE_MODE"
  }
}
