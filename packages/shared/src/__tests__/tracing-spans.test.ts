import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Context,
  ROOT_CONTEXT,
} from "@opentelemetry/api"

import {
  CortexAttributes,
  withSpan,
  injectTraceContext,
  extractTraceContext,
  withExtractedContext,
  activeSpan,
  setSpanAttributes,
  addSpanEvent,
} from "../tracing/spans.js"

// ──────────────────────────────────────────────────
// Semantic Attribute Constants
// ──────────────────────────────────────────────────

describe("CortexAttributes", () => {
  it("defines expected attribute keys", () => {
    expect(CortexAttributes.JOB_ID).toBe("cortex.job.id")
    expect(CortexAttributes.AGENT_ID).toBe("cortex.agent.id")
    expect(CortexAttributes.BACKEND_ID).toBe("cortex.backend.id")
    expect(CortexAttributes.APPROVAL_ID).toBe("cortex.approval.id")
    expect(CortexAttributes.APPROVAL_DECISION).toBe("cortex.approval.decision")
    expect(CortexAttributes.EXECUTION_STATUS).toBe("cortex.execution.status")
    expect(CortexAttributes.TOKEN_INPUT).toBe("cortex.tokens.input")
    expect(CortexAttributes.TOKEN_OUTPUT).toBe("cortex.tokens.output")
    expect(CortexAttributes.ERROR_CATEGORY).toBe("cortex.error.category")
    expect(CortexAttributes.ERROR_RETRYABLE).toBe("cortex.error.retryable")
    expect(CortexAttributes.CIRCUIT_STATE).toBe("cortex.circuit.state")
  })
})

// ──────────────────────────────────────────────────
// withSpan
// ──────────────────────────────────────────────────

describe("withSpan", () => {
  it("returns the result of the wrapped function", async () => {
    const result = await withSpan("test.span", {}, async () => {
      return 42
    })
    expect(result).toBe(42)
  })

  it("propagates errors from the wrapped function", async () => {
    await expect(
      withSpan("test.error", {}, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
  })

  it("passes span to the callback", async () => {
    let receivedSpan: Span | undefined
    await withSpan("test.callback", {}, async (span) => {
      receivedSpan = span
    })
    expect(receivedSpan).toBeDefined()
  })

  it("handles async work correctly", async () => {
    const result = await withSpan("test.async", {}, async () => {
      await new Promise((r) => setTimeout(r, 10))
      return "done"
    })
    expect(result).toBe("done")
  })
})

// ──────────────────────────────────────────────────
// Trace Context Propagation
// ──────────────────────────────────────────────────

describe("injectTraceContext", () => {
  it("returns a carrier object", () => {
    const carrier = injectTraceContext()
    expect(carrier).toBeDefined()
    expect(typeof carrier).toBe("object")
  })

  it("mutates an existing carrier in place", () => {
    const carrier: Record<string, string> = { existing: "value" }
    const result = injectTraceContext(carrier)
    expect(result).toBe(carrier)
    expect(carrier.existing).toBe("value")
  })
})

describe("extractTraceContext", () => {
  it("returns a Context object", () => {
    const ctx = extractTraceContext({})
    expect(ctx).toBeDefined()
  })

  it("extracts context from a valid traceparent", () => {
    const carrier = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    }
    const ctx = extractTraceContext(carrier)
    expect(ctx).toBeDefined()
  })
})

describe("withExtractedContext", () => {
  it("executes the function and returns its result", async () => {
    const result = await withExtractedContext({}, async () => "hello")
    expect(result).toBe("hello")
  })

  it("propagates errors", async () => {
    await expect(
      withExtractedContext({}, async () => {
        throw new Error("context error")
      }),
    ).rejects.toThrow("context error")
  })
})

// ──────────────────────────────────────────────────
// Utility functions (no-op safe)
// ──────────────────────────────────────────────────

describe("activeSpan", () => {
  it("returns undefined when no span is active", () => {
    expect(activeSpan()).toBeUndefined()
  })
})

describe("setSpanAttributes", () => {
  it("does not throw when no span is active", () => {
    expect(() => setSpanAttributes({ key: "value" })).not.toThrow()
  })
})

describe("addSpanEvent", () => {
  it("does not throw when no span is active", () => {
    expect(() => addSpanEvent("test.event", { key: "value" })).not.toThrow()
  })
})
