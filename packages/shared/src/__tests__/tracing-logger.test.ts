import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTracingLogger, type TracingLogger } from "../tracing/logger.js"

describe("createTracingLogger", () => {
  let originalConsole: {
    info: typeof console.info
    warn: typeof console.warn
    error: typeof console.error
    debug: typeof console.debug
  }

  beforeEach(() => {
    originalConsole = {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }
    console.info = vi.fn()
    console.warn = vi.fn()
    console.error = vi.fn()
    console.debug = vi.fn()
  })

  afterEach(() => {
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    console.debug = originalConsole.debug
  })

  it("creates a logger with all log levels", () => {
    const logger = createTracingLogger()
    expect(logger.info).toBeDefined()
    expect(logger.warn).toBeDefined()
    expect(logger.error).toBeDefined()
    expect(logger.debug).toBeDefined()
  })

  it("outputs JSON-structured log lines", () => {
    const logger = createTracingLogger()
    logger.info("test message")

    expect(console.info).toHaveBeenCalledOnce()
    const output = (console.info as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    expect(parsed.level).toBe("info")
    expect(parsed.msg).toBe("test message")
    expect(parsed.time).toBeDefined()
  })

  it("includes context fields in output", () => {
    const logger = createTracingLogger()
    logger.info("with context", { jobId: "j-123", agentId: "a-456" })

    const output = (console.info as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    expect(parsed.jobId).toBe("j-123")
    expect(parsed.agentId).toBe("a-456")
  })

  it("includes base context in all log lines", () => {
    const logger = createTracingLogger({ service: "test" })
    logger.warn("warning")

    const output = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    expect(parsed.service).toBe("test")
    expect(parsed.level).toBe("warn")
  })

  it("merges base context with per-call context", () => {
    const logger = createTracingLogger({ service: "test" })
    logger.error("err", { extra: "data" })

    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    expect(parsed.service).toBe("test")
    expect(parsed.extra).toBe("data")
    expect(parsed.level).toBe("error")
  })

  it("logs at debug level", () => {
    const logger = createTracingLogger()
    logger.debug("debug msg")

    const output = (console.debug as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    expect(parsed.level).toBe("debug")
    expect(parsed.msg).toBe("debug msg")
  })

  it("includes time field in ISO 8601 format", () => {
    const logger = createTracingLogger()
    logger.info("time test")

    const output = (console.info as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const parsed = JSON.parse(output)

    // Should be a valid ISO 8601 date
    expect(new Date(parsed.time).toISOString()).toBe(parsed.time)
  })
})
