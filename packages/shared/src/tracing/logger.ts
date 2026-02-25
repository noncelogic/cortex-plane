/**
 * Structured JSON logger with automatic trace context inclusion.
 *
 * Every log entry includes traceId and spanId from the active OTel span
 * (if any), enabling log→trace correlation in observability backends.
 */

import { trace } from "@opentelemetry/api"

export type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface TracingLoggerOptions {
  /** Minimum log level to emit. Defaults to "info". */
  level?: LogLevel
  /** Service name to include in every log line. */
  serviceName?: string
}

export class TracingLogger {
  private readonly minLevel: number
  private readonly serviceName: string

  constructor(options?: TracingLoggerOptions) {
    this.minLevel = LOG_LEVEL_ORDER[options?.level ?? "info"]
    this.serviceName = options?.serviceName ?? "cortex"
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("debug", message, extra)
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("info", message, extra)
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("warn", message, extra)
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log("error", message, extra)
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < this.minLevel) return

    const entry: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      service: this.serviceName,
      msg: message,
    }

    // Auto-inject trace context from active span
    const span = trace.getActiveSpan()
    if (span) {
      const ctx = span.spanContext()
      entry.traceId = ctx.traceId
      entry.spanId = ctx.spanId
    }

    if (extra) {
      Object.assign(entry, extra)
    }

    // Use stderr for error/warn to match unix conventions
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout
    out.write(JSON.stringify(entry) + "\n")
  }
}
