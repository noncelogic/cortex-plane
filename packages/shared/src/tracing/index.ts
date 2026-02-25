/**
 * OpenTelemetry SDK initialization.
 *
 * Call `initTracing()` once before the application starts.
 * Call `shutdownTracing()` during graceful shutdown to flush buffered spans.
 *
 * When tracing is disabled (or the collector is unreachable), the OTel API
 * falls back to no-op implementations — zero overhead on the hot path.
 */

import { NodeSDK } from "@opentelemetry/sdk-node"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { AlwaysOnSampler, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node"

export interface TracingConfig {
  /** Enable tracing (default: true) */
  enabled: boolean
  /** OTLP collector endpoint (default: http://localhost:4318) */
  endpoint: string
  /** Sampling rate 0.0–1.0 (default: 1.0) */
  sampleRate: number
  /** Service name for resource attribution */
  serviceName: string
  /** Exporter type: otlp (production), console (dev), none (disabled) */
  exporterType: "otlp" | "console" | "none"
}

export const DEFAULT_TRACING_CONFIG: TracingConfig = {
  enabled: true,
  endpoint: "http://localhost:4318",
  sampleRate: 1.0,
  serviceName: "cortex-control-plane",
  exporterType: "otlp",
}

let sdk: NodeSDK | undefined

/**
 * Initialize the OpenTelemetry SDK. Must be called before any instrumented
 * code runs (i.e., before Fastify starts).
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initTracing(config: Partial<TracingConfig> = {}): void {
  if (sdk) return

  const resolved: TracingConfig = { ...DEFAULT_TRACING_CONFIG, ...config }

  if (!resolved.enabled || resolved.exporterType === "none") {
    return
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: resolved.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
  })

  const sampler = resolved.sampleRate >= 1.0
    ? new AlwaysOnSampler()
    : new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(resolved.sampleRate) })

  const spanProcessor = resolved.exporterType === "console"
    ? new SimpleSpanProcessor(new ConsoleSpanExporter())
    : new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${resolved.endpoint}/v1/traces` }),
      )

  sdk = new NodeSDK({
    resource,
    sampler,
    spanProcessors: [spanProcessor],
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
    ],
  })

  sdk.start()
}

/**
 * Gracefully shut down the SDK, flushing any buffered spans.
 * Returns a promise that resolves when all exporters have flushed.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return
  try {
    await sdk.shutdown()
  } finally {
    sdk = undefined
  }
}

export { type TracingConfig as TracingConfiguration }
