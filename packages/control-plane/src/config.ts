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

export interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  authUrl?: string
  tokenUrl?: string
}

export interface AuthOAuthConfig {
  dashboardUrl: string
  credentialMasterKey: string
  sessionMaxAge: number
  google?: OAuthProviderConfig
  github?: OAuthProviderConfig
  googleAntigravity?: OAuthProviderConfig
  openaiCodex?: OAuthProviderConfig
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
  /** Number of session messages to batch before scheduling memory extraction. */
  memoryExtractThreshold: number
  /** Qdrant REST URL */
  qdrantUrl: string
  /** OpenTelemetry tracing configuration */
  tracing: TracingConfig
  /** OAuth & dashboard authentication (optional — auth disabled if absent) */
  auth?: AuthOAuthConfig
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
    throw new Error(
      `Invalid OTEL_EXPORTER_TYPE: ${exporterType}. Must be "otlp", "console", or "both".`,
    )
  }

  // Auth/OAuth config — optional, features disabled if master key missing
  let auth: AuthOAuthConfig | undefined
  const masterKey = env.CREDENTIAL_MASTER_KEY
  if (masterKey) {
    const dashboardUrl = env.DASHBOARD_URL ?? env.DASHBOARD_ORIGIN ?? "http://localhost:3100"
    auth = {
      dashboardUrl,
      credentialMasterKey: masterKey,
      sessionMaxAge: parseIntOr(env.SESSION_MAX_AGE_SECONDS, 7 * 24 * 3600),
      google: parseOAuthProvider(env, "GOOGLE"),
      github: parseOAuthProvider(env, "GITHUB"),
      googleAntigravity: parseOAuthProvider(env, "GOOGLE_ANTIGRAVITY"),
      openaiCodex: parseOAuthProvider(env, "OPENAI_CODEX"),
    }
  }

  return {
    databaseUrl,
    port: parseIntOr(env.PORT, 4000),
    host: env.HOST ?? "0.0.0.0",
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel: env.LOG_LEVEL ?? "info",
    workerConcurrency: parseIntOr(env.GRAPHILE_WORKER_CONCURRENCY, 5),
    memoryExtractThreshold: parseIntOr(env.MEMORY_EXTRACT_THRESHOLD, 50),
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    tracing: {
      enabled: env.OTEL_TRACING_ENABLED === "true",
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
      sampleRate: parseFloatOr(env.OTEL_SAMPLE_RATE, 1.0),
      serviceName: env.OTEL_SERVICE_NAME ?? "cortex-control-plane",
      exporterType,
    },
    auth,
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

/**
 * Parse OAuth provider config from env vars.
 * Expects OAUTH_{PREFIX}_CLIENT_ID and OAUTH_{PREFIX}_CLIENT_SECRET.
 * Returns undefined if client ID is missing (provider not configured).
 */
function parseOAuthProvider(
  env: Record<string, string | undefined>,
  prefix: string,
): OAuthProviderConfig | undefined {
  const clientId = env[`OAUTH_${prefix}_CLIENT_ID`]
  const clientSecret = env[`OAUTH_${prefix}_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return undefined
  return {
    clientId,
    clientSecret,
    authUrl: env[`OAUTH_${prefix}_AUTH_URL`],
    tokenUrl: env[`OAUTH_${prefix}_TOKEN_URL`],
  }
}
