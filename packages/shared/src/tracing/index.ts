/**
 * OpenTelemetry SDK initialization for Cortex services.
 *
 * Configures OTLP and/or console exporters with configurable sampling.
 * Initialization is idempotent — calling initTracing() multiple times is safe.
 */

import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api"
import { Resource } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { TraceIdRatioBasedSampler, AlwaysOnSampler } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"

export { CortexAttributes, withSpan, injectTraceContext, extractTraceContext } from "./spans.js"
export { TracingLogger, type LogLevel, type TracingLoggerOptions } from "./logger.js"

// ──────────────────────────────────────────────────
// Config types
// ──────────────────────────────────────────────────

export interface TracingInitConfig {
  /** Whether tracing is enabled. If false, initTracing is a no-op. */
  enabled: boolean
  /** Service name for the resource. */
  serviceName: string
  /** Service version string. */
  serviceVersion?: string
  /** OTLP endpoint URL (e.g. http://localhost:4318/v1/traces). */
  endpoint?: string
  /** Sample rate: 0.0 to 1.0. 1.0 = sample everything. */
  sampleRate?: number
  /** Exporter type: "otlp", "console", or "both". */
  exporterType?: "otlp" | "console" | "both"
  /** Enable OTel diagnostic logging (for debugging SDK issues). */
  debug?: boolean
}

// ──────────────────────────────────────────────────
// Singleton state
// ──────────────────────────────────────────────────

let provider: BasicTracerProvider | null = null

/**
 * Initialize the OTel tracing SDK. Idempotent — subsequent calls are no-ops.
 */
export function initTracing(config: TracingInitConfig): void {
  if (!config.enabled) return
  if (provider !== null) return // already initialized

  if (config.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.0",
  })

  const sampler =
    config.sampleRate !== undefined && config.sampleRate < 1.0
      ? new TraceIdRatioBasedSampler(config.sampleRate)
      : new AlwaysOnSampler()

  provider = new BasicTracerProvider({
    resource,
    sampler,
  })

  const exporterType = config.exporterType ?? "otlp"
  const exporters: SpanExporter[] = []

  if (exporterType === "otlp" || exporterType === "both") {
    exporters.push(
      new OTLPTraceExporter({
        url: config.endpoint ?? "http://localhost:4318/v1/traces",
      }),
    )
  }

  if (exporterType === "console" || exporterType === "both") {
    exporters.push(new ConsoleSpanExporter())
  }

  for (const exporter of exporters) {
    // Use SimpleSpanProcessor for console (immediate output),
    // BatchSpanProcessor for OTLP (performance).
    if (exporter instanceof ConsoleSpanExporter) {
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter))
    } else {
      provider.addSpanProcessor(new BatchSpanProcessor(exporter))
    }
  }

  provider.register()
}

/**
 * Gracefully flush and shut down the tracing provider.
 * Safe to call even if tracing was never initialized.
 */
export async function shutdownTracing(): Promise<void> {
  if (provider === null) return
  await provider.shutdown()
  provider = null
}

/**
 * Check whether tracing has been initialized.
 * Useful in tests.
 */
export function isTracingInitialized(): boolean {
  return provider !== null
}

/**
 * Reset tracing state (for tests only).
 */
export async function resetTracing(): Promise<void> {
  if (provider !== null) {
    await provider.shutdown()
    provider = null
  }
}
