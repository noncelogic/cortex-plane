/**
 * Trace-aware structured logger.
 *
 * Wraps console logging with automatic traceId / spanId correlation
 * so log lines from instrumented paths can be joined with traces in
 * an observability backend.
 *
 * Intentionally lightweight — no extra dependencies beyond @opentelemetry/api.
 */

import { context, trace } from "@opentelemetry/api"

export interface LogContext {
  [key: string]: unknown
}

export interface TracingLogger {
  info(message: string, ctx?: LogContext): void
  warn(message: string, ctx?: LogContext): void
  error(message: string, ctx?: LogContext): void
  debug(message: string, ctx?: LogContext): void
}

function getTraceFields(): Record<string, string | undefined> {
  const span = trace.getSpan(context.active())
  if (!span) return {}

  const spanContext = span.spanContext()
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  }
}

function formatLog(level: string, message: string, ctx?: LogContext): string {
  const traceFields = getTraceFields()
  const entry = {
    level,
    msg: message,
    ...traceFields,
    ...ctx,
    time: new Date().toISOString(),
  }
  return JSON.stringify(entry)
}

/**
 * Create a trace-aware structured logger.
 *
 * Each log line is JSON-formatted with traceId and spanId fields
 * (when an active span exists). This allows log → trace correlation
 * without requiring a Pino transport or OTel log bridge.
 */
export function createTracingLogger(baseCtx?: LogContext): TracingLogger {
  return {
    info(message: string, ctx?: LogContext) {
      console.info(formatLog("info", message, { ...baseCtx, ...ctx }))
    },
    warn(message: string, ctx?: LogContext) {
      console.warn(formatLog("warn", message, { ...baseCtx, ...ctx }))
    },
    error(message: string, ctx?: LogContext) {
      console.error(formatLog("error", message, { ...baseCtx, ...ctx }))
    },
    debug(message: string, ctx?: LogContext) {
      console.debug(formatLog("debug", message, { ...baseCtx, ...ctx }))
    },
  }
}
