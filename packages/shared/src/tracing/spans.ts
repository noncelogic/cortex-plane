/**
 * Span utilities for OpenTelemetry tracing.
 *
 * Provides withSpan() for wrapping async operations,
 * context propagation helpers, and attribute constants.
 */

import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api"

// ──────────────────────────────────────────────────
// Attribute constants
// ──────────────────────────────────────────────────

/** Standard attribute keys for Cortex spans. */
export const CortexAttributes = {
  JOB_ID: "cortex.job.id",
  AGENT_ID: "cortex.agent.id",
  AGENT_NAME: "cortex.agent.name",
  BACKEND_ID: "cortex.backend.id",
  PROVIDER_ID: "cortex.provider.id",
  APPROVAL_REQUEST_ID: "cortex.approval.request_id",
  APPROVAL_DECISION: "cortex.approval.decision",
  CIRCUIT_STATE: "cortex.circuit.state",
  TOKEN_INPUT: "cortex.tokens.input",
  TOKEN_OUTPUT: "cortex.tokens.output",
  TOKEN_CACHE_READ: "cortex.tokens.cache_read",
  TOKEN_CACHE_CREATION: "cortex.tokens.cache_creation",
  TOKEN_COST_USD: "cortex.tokens.cost_usd",
  ERROR_CATEGORY: "cortex.error.category",
  EXECUTION_STATUS: "cortex.execution.status",
  EXECUTION_DURATION_MS: "cortex.execution.duration_ms",
} as const

// ──────────────────────────────────────────────────
// withSpan — wraps an async function in a span
// ──────────────────────────────────────────────────

/**
 * Execute `fn` inside a new span. If `fn` throws, the span is marked as
 * errored and the exception is re-thrown. The span is always ended.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = trace.getTracer("cortex")
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      span.recordException(err instanceof Error ? err : new Error(String(err)))
      throw err
    } finally {
      span.end()
    }
  })
}

// ──────────────────────────────────────────────────
// W3C Trace Context propagation helpers
// ──────────────────────────────────────────────────

/**
 * Extract the `traceparent` header from the current active context.
 * Returns undefined if no active span exists.
 */
export function injectTraceContext(): Record<string, string> {
  const span = trace.getActiveSpan()
  if (!span) return {}

  const ctx = span.spanContext()
  const traceparent = `00-${ctx.traceId}-${ctx.spanId}-0${ctx.traceFlags.toString(16).padStart(1, "0")}`
  return { traceparent }
}

/**
 * Create a context from an incoming `traceparent` header.
 * Returns a new OTel context with the extracted span context as the remote parent.
 */
export function extractTraceContext(
  headers: Record<string, string | undefined>,
): ReturnType<typeof context.active> {
  const traceparent = headers["traceparent"] ?? headers["Traceparent"]
  if (!traceparent) return context.active()

  // Parse W3C traceparent: version-traceId-spanId-flags
  const parts = traceparent.split("-")
  if (parts.length !== 4) return context.active()

  const traceId = parts[1]
  const spanId = parts[2]
  const flags = parts[3]
  if (!traceId || !spanId || !flags) return context.active()

  const spanContext = {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  }

  return trace.setSpanContext(context.active(), spanContext)
}
