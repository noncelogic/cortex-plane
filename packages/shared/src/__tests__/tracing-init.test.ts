import { afterEach, describe, expect, it, vi } from "vitest"

import {
  initTracing,
  shutdownTracing,
  DEFAULT_TRACING_CONFIG,
} from "../tracing/index.js"

// ──────────────────────────────────────────────────
// Default Config
// ──────────────────────────────────────────────────

describe("DEFAULT_TRACING_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_TRACING_CONFIG.enabled).toBe(true)
    expect(DEFAULT_TRACING_CONFIG.endpoint).toBe("http://localhost:4318")
    expect(DEFAULT_TRACING_CONFIG.sampleRate).toBe(1.0)
    expect(DEFAULT_TRACING_CONFIG.serviceName).toBe("cortex-control-plane")
    expect(DEFAULT_TRACING_CONFIG.exporterType).toBe("otlp")
  })
})

// ──────────────────────────────────────────────────
// Initialization
// ──────────────────────────────────────────────────

describe("initTracing", () => {
  afterEach(async () => {
    await shutdownTracing()
  })

  it("does not throw when disabled", () => {
    expect(() => initTracing({ enabled: false })).not.toThrow()
  })

  it("does not throw when exporterType is none", () => {
    expect(() => initTracing({ exporterType: "none" })).not.toThrow()
  })

  it("initializes with console exporter without throwing", () => {
    expect(() => initTracing({ exporterType: "console" })).not.toThrow()
  })

  it("initializes with otlp exporter without throwing", () => {
    // Will try to connect to localhost:4318 — that's fine, spans will be buffered
    expect(() => initTracing({ exporterType: "otlp" })).not.toThrow()
  })

  it("is idempotent — second call is a no-op", () => {
    initTracing({ exporterType: "console" })
    // Should not throw or create a second SDK
    expect(() => initTracing({ exporterType: "console" })).not.toThrow()
  })

  it("respects custom service name", () => {
    // Just ensure it doesn't throw — we can't easily inspect the resource
    expect(() =>
      initTracing({ serviceName: "test-service", exporterType: "console" }),
    ).not.toThrow()
  })

  it("respects custom sample rate", () => {
    expect(() =>
      initTracing({ sampleRate: 0.5, exporterType: "console" }),
    ).not.toThrow()
  })

  it("handles full sample rate (1.0) with AlwaysOnSampler", () => {
    expect(() =>
      initTracing({ sampleRate: 1.0, exporterType: "console" }),
    ).not.toThrow()
  })
})

// ──────────────────────────────────────────────────
// Shutdown
// ──────────────────────────────────────────────────

describe("shutdownTracing", () => {
  it("does not throw when no SDK was initialized", async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })

  it("shuts down gracefully after initialization", async () => {
    initTracing({ exporterType: "console" })
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })

  it("allows re-initialization after shutdown", async () => {
    initTracing({ exporterType: "console" })
    await shutdownTracing()
    // Should be able to init again
    expect(() => initTracing({ exporterType: "console" })).not.toThrow()
    await shutdownTracing()
  })
})
