import { describe, expect, it } from "vitest"

import { loadConfig } from "../config.js"

describe("loadConfig", () => {
  it("throws if DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL is required")
  })

  it("returns defaults when only DATABASE_URL is set", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" })
    expect(config).toEqual({
      databaseUrl: "postgres://localhost/test",
      port: 4000,
      host: "0.0.0.0",
      nodeEnv: "development",
      logLevel: "info",
      workerConcurrency: 5,
      qdrantUrl: "http://localhost:6333",
      tracing: {
        enabled: true,
        endpoint: "http://localhost:4318",
        sampleRate: 1.0,
        serviceName: "cortex-control-plane",
        exporterType: "console",
      },
    })
  })

  it("overrides defaults from env", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      PORT: "3000",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      GRAPHILE_WORKER_CONCURRENCY: "10",
      QDRANT_URL: "http://qdrant:6333",
    })

    expect(config.port).toBe(3000)
    expect(config.host).toBe("127.0.0.1")
    expect(config.nodeEnv).toBe("production")
    expect(config.logLevel).toBe("warn")
    expect(config.workerConcurrency).toBe(10)
    expect(config.qdrantUrl).toBe("http://qdrant:6333")
  })

  it("falls back to default when PORT is not a valid integer", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      PORT: "not-a-number",
    })
    expect(config.port).toBe(4000)
  })

  // ── Tracing config ──

  it("returns tracing defaults for development", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" })
    expect(config.tracing.enabled).toBe(true)
    expect(config.tracing.endpoint).toBe("http://localhost:4318")
    expect(config.tracing.sampleRate).toBe(1.0)
    expect(config.tracing.serviceName).toBe("cortex-control-plane")
    expect(config.tracing.exporterType).toBe("console")
  })

  it("uses production defaults when NODE_ENV=production", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      NODE_ENV: "production",
    })
    expect(config.tracing.sampleRate).toBe(0.1)
    expect(config.tracing.exporterType).toBe("otlp")
  })

  it("overrides tracing config from env", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      OTEL_TRACING_ENABLED: "false",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318",
      OTEL_TRACES_SAMPLE_RATE: "0.5",
      OTEL_SERVICE_NAME: "my-service",
      OTEL_EXPORTER_TYPE: "otlp",
    })
    expect(config.tracing.enabled).toBe(false)
    expect(config.tracing.endpoint).toBe("http://jaeger:4318")
    expect(config.tracing.sampleRate).toBe(0.5)
    expect(config.tracing.serviceName).toBe("my-service")
    expect(config.tracing.exporterType).toBe("otlp")
  })

  it("clamps sample rate to [0, 1]", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      OTEL_TRACES_SAMPLE_RATE: "5.0",
    })
    expect(config.tracing.sampleRate).toBeLessThanOrEqual(1.0)
    expect(config.tracing.sampleRate).toBeGreaterThanOrEqual(0)
  })

  it("falls back on invalid exporter type", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      OTEL_EXPORTER_TYPE: "invalid",
    })
    expect(config.tracing.exporterType).toBe("console") // dev default
  })

  it("falls back on invalid sample rate string", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      OTEL_TRACES_SAMPLE_RATE: "not-a-number",
    })
    expect(config.tracing.sampleRate).toBe(1.0) // dev default
  })
})
