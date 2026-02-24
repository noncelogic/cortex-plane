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
})
