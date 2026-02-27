/**
 * Tests for the structured TracingLogger.
 */
import { trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest"

import { TracingLogger } from "../tracing/logger.js"

// Single provider for the entire file — NodeTracerProvider registers
// an AsyncHooks context manager for proper startActiveSpan support.
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("TracingLogger", () => {
  let stdoutWrite: MockInstance
  let stderrWrite: MockInstance

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  })

  function parseStdout(): Record<string, unknown> {
    return JSON.parse(String(stdoutWrite.mock.calls[0]?.[0])) as Record<string, unknown>
  }

  function parseStderr(): Record<string, unknown> {
    return JSON.parse(String(stderrWrite.mock.calls[0]?.[0])) as Record<string, unknown>
  }

  it("logs info messages to stdout as JSON", () => {
    const logger = new TracingLogger({ level: "info", serviceName: "test" })
    logger.info("hello world")

    expect(stdoutWrite).toHaveBeenCalledOnce()
    const output = parseStdout()
    expect(output.level).toBe("info")
    expect(output.msg).toBe("hello world")
    expect(output.service).toBe("test")
    expect(output.time).toBeDefined()
  })

  it("logs error messages to stderr", () => {
    const logger = new TracingLogger({ level: "info" })
    logger.error("something broke")

    expect(stderrWrite).toHaveBeenCalledOnce()
    const output = parseStderr()
    expect(output.level).toBe("error")
    expect(output.msg).toBe("something broke")
  })

  it("logs warn messages to stderr", () => {
    const logger = new TracingLogger({ level: "info" })
    logger.warn("careful")

    expect(stderrWrite).toHaveBeenCalledOnce()
    const output = parseStderr()
    expect(output.level).toBe("warn")
  })

  it("respects minimum log level", () => {
    const logger = new TracingLogger({ level: "warn" })
    logger.debug("hidden")
    logger.info("hidden too")
    logger.warn("visible")

    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(stderrWrite).toHaveBeenCalledOnce()
  })

  it("includes extra fields in output", () => {
    const logger = new TracingLogger({ level: "info" })
    logger.info("with extras", { jobId: "j-1", count: 42 })

    const output = parseStdout()
    expect(output.jobId).toBe("j-1")
    expect(output.count).toBe(42)
  })

  it("includes traceId and spanId from active span", () => {
    const logger = new TracingLogger({ level: "info" })
    const tracer = trace.getTracer("test")

    tracer.startActiveSpan("test.log", (span) => {
      logger.info("inside span")
      span.end()
    })

    const output = parseStdout()
    expect(output.traceId).toBeDefined()
    expect(output.spanId).toBeDefined()
    expect(output.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(output.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it("does not include traceId/spanId when no active span", () => {
    const logger = new TracingLogger({ level: "info" })
    logger.info("no span")

    const output = parseStdout()
    expect(output.traceId).toBeUndefined()
    expect(output.spanId).toBeUndefined()
  })

  it("defaults to cortex service name", () => {
    const logger = new TracingLogger()
    logger.info("default service")

    const output = parseStdout()
    expect(output.service).toBe("cortex")
  })
})
