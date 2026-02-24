import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loadConfig } from "../config.js"

describe("loadConfig", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env["DISCORD_BOT_TOKEN"]
    delete process.env["DISCORD_APPLICATION_ID"]
    delete process.env["DISCORD_ALLOWED_GUILDS"]
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("throws if DISCORD_BOT_TOKEN is missing", () => {
    process.env["DISCORD_APPLICATION_ID"] = "123456"
    expect(() => loadConfig()).toThrow("DISCORD_BOT_TOKEN environment variable is required")
  })

  it("throws if DISCORD_APPLICATION_ID is missing", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    expect(() => loadConfig()).toThrow("DISCORD_APPLICATION_ID environment variable is required")
  })

  it("returns config with token, appId and empty allowed guilds", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    process.env["DISCORD_APPLICATION_ID"] = "123456"

    const config = loadConfig()

    expect(config.botToken).toBe("test-token")
    expect(config.applicationId).toBe("123456")
    expect(config.allowedGuilds.size).toBe(0)
    expect(config.intents.length).toBeGreaterThan(0)
  })

  it("parses comma-separated DISCORD_ALLOWED_GUILDS", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    process.env["DISCORD_APPLICATION_ID"] = "123456"
    process.env["DISCORD_ALLOWED_GUILDS"] = "111,222,333"

    const config = loadConfig()

    expect(config.allowedGuilds).toEqual(new Set(["111", "222", "333"]))
  })

  it("trims whitespace from guild IDs", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    process.env["DISCORD_APPLICATION_ID"] = "123456"
    process.env["DISCORD_ALLOWED_GUILDS"] = " 111 , 222 "

    const config = loadConfig()

    expect(config.allowedGuilds).toEqual(new Set(["111", "222"]))
  })

  it("ignores empty segments", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    process.env["DISCORD_APPLICATION_ID"] = "123456"
    process.env["DISCORD_ALLOWED_GUILDS"] = "111,,222,"

    const config = loadConfig()

    expect(config.allowedGuilds).toEqual(new Set(["111", "222"]))
  })

  it("throws on non-numeric guild ID", () => {
    process.env["DISCORD_BOT_TOKEN"] = "test-token"
    process.env["DISCORD_APPLICATION_ID"] = "123456"
    process.env["DISCORD_ALLOWED_GUILDS"] = "111,abc"

    expect(() => loadConfig()).toThrow('Invalid guild ID in DISCORD_ALLOWED_GUILDS: "abc"')
  })
})
