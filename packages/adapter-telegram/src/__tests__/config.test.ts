import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loadConfig } from "../config.js"

describe("loadConfig", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env["TELEGRAM_BOT_TOKEN"]
    delete process.env["TELEGRAM_ALLOWED_USERS"]
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("throws if TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() => loadConfig()).toThrow("TELEGRAM_BOT_TOKEN environment variable is required")
  })

  it("returns config with bot token and empty allowed users", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"

    const config = loadConfig()

    expect(config.botToken).toBe("123:ABC")
    expect(config.allowedUsers.size).toBe(0)
  })

  it("parses comma-separated TELEGRAM_ALLOWED_USERS", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = "111,222,333"

    const config = loadConfig()

    expect(config.allowedUsers).toEqual(new Set([111, 222, 333]))
  })

  it("trims whitespace from user IDs", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = " 111 , 222 "

    const config = loadConfig()

    expect(config.allowedUsers).toEqual(new Set([111, 222]))
  })

  it("ignores empty segments", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = "111,,222,"

    const config = loadConfig()

    expect(config.allowedUsers).toEqual(new Set([111, 222]))
  })

  it("throws on non-integer user ID", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = "111,abc"

    expect(() => loadConfig()).toThrow('Invalid user ID in TELEGRAM_ALLOWED_USERS: "abc"')
  })

  it("throws on negative user ID", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = "-1"

    expect(() => loadConfig()).toThrow('Invalid user ID in TELEGRAM_ALLOWED_USERS: "-1"')
  })

  it("throws on zero user ID", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:ABC"
    process.env["TELEGRAM_ALLOWED_USERS"] = "0"

    expect(() => loadConfig()).toThrow('Invalid user ID in TELEGRAM_ALLOWED_USERS: "0"')
  })
})
