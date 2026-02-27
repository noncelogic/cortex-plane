/**
 * Tests for tracing span utilities.
 *
 * Uses NodeTracerProvider which registers an AsyncHooks context manager,
 * enabling proper context propagation needed by startActiveSpan.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CortexAttributes, extractTraceContext } from "../tracing/spans.js"

// Single provider for the entire file — NodeTracerProvider registers
// an AsyncHooks context manager so startActiveSpan works properly.
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

describe("CortexAttributes", () => {
  it("contains expected attribute keys", () => {
    expect(CortexAttributes.JOB_ID).toBe("cortex.job.id")
    expect(CortexAttributes.AGENT_ID).toBe("cortex.agent.id")
    expect(CortexAttributes.TOKEN_INPUT).toBe("cortex.tokens.input")
    expect(CortexAttributes.CIRCUIT_STATE).toBe("cortex.circuit.state")
  })
})

describe("withSpan", () => {
  it("creates a span and returns the function result", async () => {
    exporter.reset()
    const { withSpan } = await import("../tracing/spans.js")

    const result = await withSpan("test.operation", () => Promise.resolve(42))

    expect(result).toBe(42)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.name).toBe("test.operation")
    expect(span.status.code).toBe(SpanStatusCode.OK)
  })

  it("sets attributes on the span", async () => {
    exporter.reset()
    const { withSpan } = await import("../tracing/spans.js")

    await withSpan("test.with-attrs", () => Promise.resolve("ok"), {
      "test.key": "value",
      "test.num": 123,
    })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.attributes["test.key"]).toBe("value")
    expect(span.attributes["test.num"]).toBe(123)
  })

  it("marks span as error when function throws", async () => {
    exporter.reset()
    const { withSpan } = await import("../tracing/spans.js")

    await expect(
      withSpan("test.error", () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.status.message).toBe("boom")
    expect(span.events).toHaveLength(1)
    expect(span.events[0]!.name).toBe("exception")
  })

  it("allows setting custom attributes inside the callback", async () => {
    exporter.reset()
    const { withSpan } = await import("../tracing/spans.js")

    await withSpan("test.custom", (span) => {
      span.setAttribute(CortexAttributes.JOB_ID, "job-123")
      return Promise.resolve()
    })

    const spans = exporter.getFinishedSpans()
    const span = spans[0]!
    expect(span.attributes[CortexAttributes.JOB_ID]).toBe("job-123")
  })
})

describe("injectTraceContext", () => {
  it("returns traceparent header within an active span", async () => {
    const { injectTraceContext } = await import("../tracing/spans.js")
    const tracer = trace.getTracer("test")

    tracer.startActiveSpan("test.inject", (span) => {
      const headers = injectTraceContext()
      expect(headers.traceparent).toBeDefined()
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/)
      span.end()
    })
  })
})

describe("extractTraceContext", () => {
  it("returns current context when no traceparent header", () => {
    const ctx = extractTraceContext({})
    expect(ctx).toBeDefined()
  })

  it("returns current context for invalid traceparent", () => {
    const ctx = extractTraceContext({ traceparent: "invalid" })
    expect(ctx).toBeDefined()
  })

  it("extracts span context from valid traceparent", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c"
    const spanId = "b7ad6b7169203331"
    const traceparent = `00-${traceId}-${spanId}-01`

    const ctx = extractTraceContext({ traceparent })
    const extracted = trace.getSpanContext(ctx)

    expect(extracted).toBeDefined()
    expect(extracted?.traceId).toBe(traceId)
    expect(extracted?.spanId).toBe(spanId)
    expect(extracted?.isRemote).toBe(true)
  })
})
