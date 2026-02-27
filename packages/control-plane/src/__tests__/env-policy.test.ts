import { describe, expect, it, vi } from "vitest"

import { buildBackendBaseEnv, buildBackendSpawnEnv } from "../backends/env-policy.js"

describe("backend env policy", () => {
  it("includes only allowlisted process env vars in base env", () => {
    const originalEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      DATABASE_URL: process.env.DATABASE_URL,
      INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
    }

    process.env.PATH = "/usr/bin:/bin"
    process.env.HOME = "/home/cortex"
    process.env.LANG = "en_US.UTF-8"
    process.env.DATABASE_URL = "postgres://secret"
    process.env.INTERNAL_API_KEY = "internal-secret"

    try {
      const env = buildBackendBaseEnv()
      expect(env.PATH).toBe("/usr/bin:/bin")
      expect(env.HOME).toBe("/home/cortex")
      expect(env.LANG).toBe("en_US.UTF-8")
      expect(env.DATABASE_URL).toBeUndefined()
      expect(env.INTERNAL_API_KEY).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it("includes only allowlisted task env vars and logs injected key names", () => {
    const logInfo = vi.fn()

    const env = buildBackendSpawnEnv(
      {
        ANTHROPIC_API_KEY: "sk-anthropic",
        OPENAI_API_KEY: "sk-openai",
        DATABASE_URL: "postgres://secret",
        INTERNAL_API_KEY: "internal-secret",
        TASK_ONLY_FLAG: "enabled",
      },
      logInfo,
    )

    expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic")
    expect(env.OPENAI_API_KEY).toBe("sk-openai")
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.INTERNAL_API_KEY).toBeUndefined()
    expect(env.TASK_ONLY_FLAG).toBeUndefined()
    expect(logInfo).toHaveBeenCalledWith(
      "[backend-env] injected env keys for backend process",
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        keys: expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]),
      }),
    )
  })
})
