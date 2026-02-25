/**
 * Configuration module — validates environment variables at startup.
 *
 * All config is sourced from process.env and validated eagerly.
 * Missing required values throw immediately so the process fails fast.
 */

export interface TracingConfig {
  /** Whether OpenTelemetry tracing is enabled. */
  enabled: boolean
  /** OTLP collector endpoint URL. */
  endpoint: string
  /** Sampling rate: 0.0 to 1.0. */
  sampleRate: number
  /** Service name for the OTel resource. */
  serviceName: string
  /** Exporter type: "otlp", "console", or "both". */
  exporterType: "otlp" | "console" | "both"
}

export interface Config {
  /** PostgreSQL connection string */
  databaseUrl: string
  /** HTTP server port */
  port: number
  /** HTTP server host (bind address) */
  host: string
  /** Node environment (development, production, test) */
  nodeEnv: string
  /** Pino log level */
  logLevel: string
  /** Graphile Worker concurrency */
  workerConcurrency: number
  /** Qdrant REST URL */
  qdrantUrl: string
  /** OpenTelemetry tracing configuration */
  tracing: TracingConfig
}

/**
 * Load and validate configuration from environment variables.
 * Throws if required values are missing.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required")
  }

  const exporterType = env.OTEL_EXPORTER_TYPE ?? "otlp"
  if (exporterType !== "otlp" && exporterType !== "console" && exporterType !== "both") {
    throw new Error(`Invalid OTEL_EXPORTER_TYPE: ${exporterType}. Must be "otlp", "console", or "both".`)
  }

  return {
    databaseUrl,
    port: parseIntOr(env.PORT, 4000),
    host: env.HOST ?? "0.0.0.0",
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel: env.LOG_LEVEL ?? "info",
    workerConcurrency: parseIntOr(env.GRAPHILE_WORKER_CONCURRENCY, 5),
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    tracing: {
      enabled: env.OTEL_TRACING_ENABLED === "true",
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
      sampleRate: parseFloatOr(env.OTEL_SAMPLE_RATE, 1.0),
      serviceName: env.OTEL_SERVICE_NAME ?? "cortex-control-plane",
      exporterType,
    },
  }
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return parsed
}

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = parseFloat(value)
  if (Number.isNaN(parsed)) return fallback
  return Math.max(0, Math.min(1, parsed))
}
