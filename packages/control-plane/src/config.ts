/**
 * Configuration module — validates environment variables at startup.
 *
 * All config is sourced from process.env and validated eagerly.
 * Missing required values throw immediately so the process fails fast.
 */

export interface TracingConfig {
  /** Enable tracing (default: true) */
  enabled: boolean
  /** OTLP collector endpoint (default: http://localhost:4318) */
  endpoint: string
  /** Sampling rate 0.0–1.0 (default: 1.0 for dev, 0.1 for prod) */
  sampleRate: number
  /** Service name for resource attribution */
  serviceName: string
  /** Exporter type: otlp (production), console (dev), none (disabled) */
  exporterType: "otlp" | "console" | "none"
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

  const nodeEnv = env.NODE_ENV ?? "development"
  const isProd = nodeEnv === "production"

  return {
    databaseUrl,
    port: parseIntOr(env.PORT, 4000),
    host: env.HOST ?? "0.0.0.0",
    nodeEnv,
    logLevel: env.LOG_LEVEL ?? "info",
    workerConcurrency: parseIntOr(env.GRAPHILE_WORKER_CONCURRENCY, 5),
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    tracing: {
      enabled: env.OTEL_TRACING_ENABLED !== "false",
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
      sampleRate: parseFloatOr(env.OTEL_TRACES_SAMPLE_RATE, isProd ? 0.1 : 1.0),
      serviceName: env.OTEL_SERVICE_NAME ?? "cortex-control-plane",
      exporterType: parseExporterType(env.OTEL_EXPORTER_TYPE, isProd ? "otlp" : "console"),
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

function parseExporterType(
  value: string | undefined,
  fallback: TracingConfig["exporterType"],
): TracingConfig["exporterType"] {
  if (value === "otlp" || value === "console" || value === "none") return value
  return fallback
}
