/**
 * Lifecycle observability — Prometheus-style metrics + structured logs.
 *
 * Metrics are created via the OpenTelemetry API (`@opentelemetry/api`).
 * Without a registered MeterProvider they are no-ops; once a provider is
 * configured (e.g. Prometheus exporter) the counters and histograms
 * automatically start recording.
 *
 * Every `record*` helper also emits a structured JSON log line for
 * log-based observability (ELK / CloudWatch / etc.).
 */

import { metrics } from "@opentelemetry/api"

import type { LifecycleTransitionEvent } from "./state-machine.js"

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

const meter = metrics.getMeter("cortex-lifecycle")

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const stateTransitionsTotal = meter.createCounter("cortex_agent_state_transitions_total", {
  description: "Total number of agent state transitions",
})

export const circuitBreakerTripsTotal = meter.createCounter(
  "cortex_agent_circuit_breaker_trips_total",
  { description: "Total circuit breaker trips" },
)

export const contextBudgetExceededTotal = meter.createCounter(
  "cortex_agent_context_budget_exceeded_total",
  { description: "Total context budget exceeded events" },
)

export const outputValidationRejectedTotal = meter.createCounter(
  "cortex_agent_output_validation_rejected_total",
  { description: "Total output validation rejections" },
)

export const checkpointWritesTotal = meter.createCounter("cortex_agent_checkpoint_writes_total", {
  description: "Total checkpoint writes",
})

export const tokenUsageTotal = meter.createCounter("cortex_agent_token_usage_total", {
  description: "Total token usage",
})

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export const quarantineDurationSeconds = meter.createHistogram(
  "cortex_agent_quarantine_duration_seconds",
  { description: "Duration agents spend in quarantine", unit: "s" },
)

export const healthProbeDurationSeconds = meter.createHistogram(
  "cortex_agent_health_probe_duration_seconds",
  { description: "Duration of agent health probes", unit: "s" },
)

// ---------------------------------------------------------------------------
// Structured lifecycle log
// ---------------------------------------------------------------------------

export interface LifecycleLogEntry {
  event: string
  agentId: string
  jobId?: string
  from?: string
  to?: string
  reason?: string
  metadata?: Record<string, unknown>
}

/**
 * Emit a structured JSON log line to stdout.
 *
 * The format is compatible with the existing `TracingLogger` output so
 * downstream consumers (Pino transports, log aggregators) can ingest it
 * without special configuration.
 */
export function emitLifecycleLog(entry: LifecycleLogEntry): void {
  const log: Record<string, unknown> = {
    level: "info",
    time: new Date().toISOString(),
    service: "cortex-lifecycle",
    ...entry,
  }
  process.stdout.write(JSON.stringify(log) + "\n")
}

// ---------------------------------------------------------------------------
// Record helpers — increment metric + emit structured log
// ---------------------------------------------------------------------------

export function recordStateTransition(event: LifecycleTransitionEvent): void {
  stateTransitionsTotal.add(1, {
    agent_id: event.agentId,
    from: event.from,
    to: event.to,
  })
  emitLifecycleLog({
    event: "agent.state_transition",
    agentId: event.agentId,
    from: event.from,
    to: event.to,
    reason: event.reason,
  })
}

export function recordCircuitBreakerTrip(agentId: string, reason: string): void {
  circuitBreakerTripsTotal.add(1, { agent_id: agentId, reason })
  emitLifecycleLog({
    event: "agent.circuit_breaker.tripped",
    agentId,
    reason,
  })
}

export function recordContextBudgetExceeded(agentId: string, component: string): void {
  contextBudgetExceededTotal.add(1, { agent_id: agentId, component })
  emitLifecycleLog({
    event: "agent.context_budget.exceeded",
    agentId,
    metadata: { component },
  })
}

export function recordOutputValidationRejected(agentId: string, contentType: string): void {
  outputValidationRejectedTotal.add(1, { agent_id: agentId, content_type: contentType })
  emitLifecycleLog({
    event: "agent.output_validation.rejected",
    agentId,
    metadata: { contentType },
  })
}

export function recordCheckpointWrite(agentId: string, trigger: string): void {
  checkpointWritesTotal.add(1, { agent_id: agentId, trigger })
  emitLifecycleLog({
    event: "agent.checkpoint.written",
    agentId,
    metadata: { trigger },
  })
}

export function recordTokenUsage(agentId: string, jobId: string, tokens: number): void {
  tokenUsageTotal.add(tokens, { agent_id: agentId, job_id: jobId })
  emitLifecycleLog({
    event: "agent.token_usage",
    agentId,
    jobId,
    metadata: { tokens },
  })
}
