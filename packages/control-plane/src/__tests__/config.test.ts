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
      memoryExtractThreshold: 50,
      qdrantUrl: "http://localhost:6333",
      auth: undefined,
      channels: {},
      tracing: {
        enabled: false,
        endpoint: "http://localhost:4318/v1/traces",
        sampleRate: 1.0,
        serviceName: "cortex-control-plane",
        exporterType: "otlp",
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

  describe("tracing config", () => {
    it("defaults tracing to disabled", () => {
      const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" })
      expect(config.tracing.enabled).toBe(false)
    })

    it("enables tracing when OTEL_TRACING_ENABLED is 'true'", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        OTEL_TRACING_ENABLED: "true",
      })
      expect(config.tracing.enabled).toBe(true)
    })

    it("reads tracing config from env", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        OTEL_TRACING_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/traces",
        OTEL_SAMPLE_RATE: "0.5",
        OTEL_SERVICE_NAME: "my-service",
        OTEL_EXPORTER_TYPE: "both",
      })

      expect(config.tracing).toEqual({
        enabled: true,
        endpoint: "http://collector:4318/v1/traces",
        sampleRate: 0.5,
        serviceName: "my-service",
        exporterType: "both",
      })
    })

    it("clamps sample rate to [0, 1]", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        OTEL_SAMPLE_RATE: "5.0",
      })
      expect(config.tracing.sampleRate).toBe(1.0)
    })

    it("falls back on invalid sample rate", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        OTEL_SAMPLE_RATE: "not-a-number",
      })
      expect(config.tracing.sampleRate).toBe(1.0)
    })

    it("throws on invalid exporter type", () => {
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgres://localhost/test",
          OTEL_EXPORTER_TYPE: "invalid",
        }),
      ).toThrow("Invalid OTEL_EXPORTER_TYPE: invalid")
    })
  })

  describe("channel config", () => {
    it("returns empty channels when no channel env vars are set", () => {
      const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" })
      expect(config.channels).toEqual({})
      expect(config.channels.telegram).toBeUndefined()
      expect(config.channels.discord).toBeUndefined()
    })

    it("parses Telegram config from env vars", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        CHANNEL_TELEGRAM_BOT_TOKEN: "123:ABC",
        CHANNEL_TELEGRAM_ALLOWED_USERS: "111,222,333",
      })
      expect(config.channels.telegram).toBeDefined()
      expect(config.channels.telegram!.botToken).toBe("123:ABC")
      expect(config.channels.telegram!.allowedUsers).toEqual(new Set([111, 222, 333]))
    })

    it("parses Telegram config with empty allowed users", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        CHANNEL_TELEGRAM_BOT_TOKEN: "123:ABC",
      })
      expect(config.channels.telegram).toBeDefined()
      expect(config.channels.telegram!.allowedUsers).toEqual(new Set())
    })

    it("throws on invalid Telegram user ID", () => {
      expect(() =>
        loadConfig({
          DATABASE_URL: "postgres://localhost/test",
          CHANNEL_TELEGRAM_BOT_TOKEN: "123:ABC",
          CHANNEL_TELEGRAM_ALLOWED_USERS: "111,abc",
        }),
      ).toThrow('Invalid Telegram user ID in CHANNEL_TELEGRAM_ALLOWED_USERS: "abc"')
    })

    it("parses Discord config from env vars", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        CHANNEL_DISCORD_TOKEN: "discord-token",
        CHANNEL_DISCORD_GUILD_IDS: "guild1,guild2",
        CHANNEL_DISCORD_ALLOWED_USERS: "user1,user2",
      })
      expect(config.channels.discord).toBeDefined()
      expect(config.channels.discord!.token).toBe("discord-token")
      expect(config.channels.discord!.guildIds).toEqual(["guild1", "guild2"])
      expect(config.channels.discord!.allowedUsers).toEqual(new Set(["user1", "user2"]))
    })

    it("parses Discord config without allowed users", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        CHANNEL_DISCORD_TOKEN: "discord-token",
        CHANNEL_DISCORD_GUILD_IDS: "guild1",
      })
      expect(config.channels.discord).toBeDefined()
      expect(config.channels.discord!.allowedUsers).toBeUndefined()
    })

    it("parses both Telegram and Discord simultaneously", () => {
      const config = loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        CHANNEL_TELEGRAM_BOT_TOKEN: "tg-token",
        CHANNEL_DISCORD_TOKEN: "dc-token",
        CHANNEL_DISCORD_GUILD_IDS: "g1",
      })
      expect(config.channels.telegram).toBeDefined()
      expect(config.channels.discord).toBeDefined()
    })
  })
})
