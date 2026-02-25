/**
 * Tracing span helpers — typed wrappers around the OpenTelemetry API.
 *
 * These helpers keep instrumentation call-sites concise and ensure
 * consistent attribute naming across the Cortex codebase.
 */

import {
  type Attributes,
  type Context,
  type Span,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api"

// ──────────────────────────────────────────────────
// Semantic Attribute Constants
// ──────────────────────────────────────────────────

/** Cortex-specific semantic attributes for span annotations. */
export const CortexAttributes = {
  JOB_ID: "cortex.job.id",
  AGENT_ID: "cortex.agent.id",
  BACKEND_ID: "cortex.backend.id",
  APPROVAL_ID: "cortex.approval.id",
  APPROVAL_DECISION: "cortex.approval.decision",
  APPROVAL_ACTOR: "cortex.approval.actor",
  APPROVAL_TTL: "cortex.approval.ttl_seconds",
  CIRCUIT_STATE: "cortex.circuit.state",
  CIRCUIT_PROVIDER: "cortex.circuit.provider",
  EXECUTION_STATUS: "cortex.execution.status",
  EXECUTION_DURATION_MS: "cortex.execution.duration_ms",
  TOKEN_INPUT: "cortex.tokens.input",
  TOKEN_OUTPUT: "cortex.tokens.output",
  TOKEN_TOTAL: "cortex.tokens.total",
  ERROR_CATEGORY: "cortex.error.category",
  ERROR_RETRYABLE: "cortex.error.retryable",
} as const

// ──────────────────────────────────────────────────
// Tracer
// ──────────────────────────────────────────────────

const TRACER_NAME = "cortex"

function getTracer() {
  return trace.getTracer(TRACER_NAME)
}

// ──────────────────────────────────────────────────
// withSpan
// ──────────────────────────────────────────────────

/**
 * Execute an async function inside a new span.
 *
 * On success the span ends with OK status; on error it records the
 * exception and sets ERROR status before re-throwing.
 *
 * ```ts
 * const result = await withSpan("cortex.job.execute", { [CortexAttributes.JOB_ID]: jobId }, async (span) => {
 *   // ... instrumented work
 * })
 * ```
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer()
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      if (err instanceof Error) {
        span.recordException(err)
      }
      throw err
    } finally {
      span.end()
    }
  })
}

// ──────────────────────────────────────────────────
// W3C Trace Context Propagation
// ──────────────────────────────────────────────────

/** Carrier type for W3C traceparent propagation. */
export type TraceCarrier = Record<string, string>

/**
 * Inject the current trace context into a carrier object.
 * Used when enqueuing Graphile Worker jobs so the downstream
 * task can continue the same trace.
 *
 * Returns the carrier (mutated in place) for convenience.
 */
export function injectTraceContext(carrier: TraceCarrier = {}): TraceCarrier {
  propagation.inject(context.active(), carrier)
  return carrier
}

/**
 * Extract trace context from a carrier and return the Context.
 * Used when a Graphile Worker task starts — it extracts the parent
 * trace from the job payload so spans are linked.
 */
export function extractTraceContext(carrier: TraceCarrier): Context {
  return propagation.extract(context.active(), carrier)
}

/**
 * Run an async function with the extracted trace context as the active context.
 * Combines extraction + context propagation in one call.
 */
export async function withExtractedContext<T>(
  carrier: TraceCarrier,
  fn: () => Promise<T>,
): Promise<T> {
  const extracted = extractTraceContext(carrier)
  return context.with(extracted, fn)
}

// ──────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────

/** Get the current active span (if any). */
export function activeSpan(): Span | undefined {
  return trace.getActiveSpan()
}

/** Add attributes to the current active span. */
export function setSpanAttributes(attributes: Attributes): void {
  const span = trace.getActiveSpan()
  if (span) {
    span.setAttributes(attributes)
  }
}

/** Record an event (log-style annotation) on the current active span. */
export function addSpanEvent(name: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan()
  if (span) {
    span.addEvent(name, attributes)
  }
}
