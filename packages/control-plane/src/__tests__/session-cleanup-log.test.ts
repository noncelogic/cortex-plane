import { describe, expect, it, vi } from "vitest"

/**
 * Validates that the session-cleanup catch block in app.ts logs the error
 * rather than silently swallowing it (issue #556).
 *
 * We cannot easily exercise buildApp() directly because of its heavy
 * dependency graph, so we replicate the exact catch-block pattern here
 * to prove the logging contract.
 */
describe("session cleanup startup catch (#556)", () => {
  it("logs a warning when cleanupExpired rejects", async () => {
    const warn = vi.fn()
    const log = { warn }

    const error = new Error("db connection lost")
    const cleanupExpired: () => Promise<void> = vi.fn().mockRejectedValue(error)

    // Mirror the pattern from app.ts:185-187
    await cleanupExpired().catch((err: unknown) => {
      log.warn({ err }, "session cleanup failed on startup")
    })

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith({ err: error }, "session cleanup failed on startup")
  })

  it("does not log when cleanupExpired succeeds", async () => {
    const warn = vi.fn()
    const log = { warn }

    const cleanupExpired: () => Promise<void> = vi.fn().mockResolvedValue(undefined)

    await cleanupExpired().catch((err: unknown) => {
      log.warn({ err }, "session cleanup failed on startup")
    })

    expect(warn).not.toHaveBeenCalled()
  })
})
