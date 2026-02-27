import { afterEach, describe, expect, it } from "vitest"

import {
  initTracing,
  isTracingInitialized,
  resetTracing,
  shutdownTracing,
} from "../tracing/index.js"

describe("initTracing", () => {
  afterEach(async () => {
    await resetTracing()
  })

  it("does nothing when enabled is false", () => {
    initTracing({
      enabled: false,
      serviceName: "test-service",
    })
    expect(isTracingInitialized()).toBe(false)
  })

  it("initializes tracing when enabled", () => {
    initTracing({
      enabled: true,
      serviceName: "test-service",
      exporterType: "console",
    })
    expect(isTracingInitialized()).toBe(true)
  })

  it("is idempotent — second call is a no-op", () => {
    initTracing({
      enabled: true,
      serviceName: "test-service",
      exporterType: "console",
    })
    expect(isTracingInitialized()).toBe(true)

    // Call again — should not throw
    initTracing({
      enabled: true,
      serviceName: "test-service-2",
      exporterType: "console",
    })
    expect(isTracingInitialized()).toBe(true)
  })
})

describe("shutdownTracing", () => {
  afterEach(async () => {
    await resetTracing()
  })

  it("is safe to call when not initialized", async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined()
  })

  it("shuts down and clears the provider", async () => {
    initTracing({
      enabled: true,
      serviceName: "test-service",
      exporterType: "console",
    })
    expect(isTracingInitialized()).toBe(true)

    await shutdownTracing()
    expect(isTracingInitialized()).toBe(false)
  })
})

describe("resetTracing", () => {
  it("resets even after initialization", async () => {
    initTracing({
      enabled: true,
      serviceName: "test-service",
      exporterType: "console",
    })
    expect(isTracingInitialized()).toBe(true)

    await resetTracing()
    expect(isTracingInitialized()).toBe(false)
  })

  it("is safe to call multiple times", async () => {
    await resetTracing()
    await resetTracing()
    expect(isTracingInitialized()).toBe(false)
  })
})
