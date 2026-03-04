/**
 * Prometheus-style lifecycle metrics (stub implementation).
 *
 * Provides Counter and Histogram stubs that track values in-memory.
 * If prom-client is added later, swap these for real prom-client instances.
 *
 * All metrics follow the naming convention:
 *   cortex_agent_<domain>_<unit>
 */

// ---------------------------------------------------------------------------
// Metric stub types
// ---------------------------------------------------------------------------

export interface CounterStub<L extends string = string> {
  inc(labels: Record<L, string>, value?: number): void
}

export interface HistogramStub<L extends string = string> {
  observe(labels: Record<L, string>, value: number): void
}

// ---------------------------------------------------------------------------
// In-memory Counter
// ---------------------------------------------------------------------------

class InMemoryCounter<L extends string> implements CounterStub<L> {
  readonly name: string
  private readonly values = new Map<string, number>()

  constructor(name: string) {
    this.name = name
  }

  inc(labels: Record<L, string>, value = 1): void {
    const key = JSON.stringify(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + value)
  }

  /** Retrieve the current value for a label combination (testing helper). */
  get(labels: Record<L, string>): number {
    return this.values.get(JSON.stringify(labels)) ?? 0
  }

  reset(): void {
    this.values.clear()
  }
}

// ---------------------------------------------------------------------------
// In-memory Histogram
// ---------------------------------------------------------------------------

class InMemoryHistogram<L extends string> implements HistogramStub<L> {
  readonly name: string
  private readonly observations = new Map<string, number[]>()

  constructor(name: string) {
    this.name = name
  }

  observe(labels: Record<L, string>, value: number): void {
    const key = JSON.stringify(labels)
    const arr = this.observations.get(key) ?? []
    arr.push(value)
    this.observations.set(key, arr)
  }

  /** Retrieve all observations for a label combination (testing helper). */
  getObservations(labels: Record<L, string>): number[] {
    return this.observations.get(JSON.stringify(labels)) ?? []
  }

  reset(): void {
    this.observations.clear()
  }
}

// ---------------------------------------------------------------------------
// Metric instances
// ---------------------------------------------------------------------------

type TransitionLabels = "agent_id" | "from" | "to"
type AgentReasonLabels = "agent_id" | "reason"
type AgentComponentLabels = "agent_id" | "component"
type AgentContentTypeLabels = "agent_id" | "content_type"
type AgentTriggerLabels = "agent_id" | "trigger"
type AgentIdLabels = "agent_id"
type AgentJobLabels = "agent_id" | "job_id"

export const stateTransitionsTotal = new InMemoryCounter<TransitionLabels>(
  "cortex_agent_state_transitions_total",
)

export const circuitBreakerTripsTotal = new InMemoryCounter<AgentReasonLabels>(
  "cortex_agent_circuit_breaker_trips_total",
)

export const contextBudgetExceededTotal = new InMemoryCounter<AgentComponentLabels>(
  "cortex_agent_context_budget_exceeded_total",
)

export const outputValidationRejectedTotal = new InMemoryCounter<AgentContentTypeLabels>(
  "cortex_agent_output_validation_rejected_total",
)

export const checkpointWritesTotal = new InMemoryCounter<AgentTriggerLabels>(
  "cortex_agent_checkpoint_writes_total",
)

export const quarantineDurationSeconds = new InMemoryHistogram<AgentIdLabels>(
  "cortex_agent_quarantine_duration_seconds",
)

export const tokenUsageTotal = new InMemoryCounter<AgentJobLabels>("cortex_agent_token_usage_total")

export const healthProbeDurationSeconds = new InMemoryHistogram<AgentIdLabels>(
  "cortex_agent_health_probe_duration_seconds",
)

// ---------------------------------------------------------------------------
// Convenience: reset all metrics (for tests)
// ---------------------------------------------------------------------------

export function resetAllMetrics(): void {
  stateTransitionsTotal.reset()
  circuitBreakerTripsTotal.reset()
  contextBudgetExceededTotal.reset()
  outputValidationRejectedTotal.reset()
  checkpointWritesTotal.reset()
  quarantineDurationSeconds.reset()
  tokenUsageTotal.reset()
  healthProbeDurationSeconds.reset()
}
