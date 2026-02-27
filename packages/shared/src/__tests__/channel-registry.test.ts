import { describe, expect, it, vi } from "vitest"

import { ChannelAdapterRegistry } from "../channels/registry.js"

function createMockAdapter(type: string, healthy = true) {
  return {
    channelType: type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(healthy),
    sendMessage: vi.fn().mockResolvedValue("msg-1"),
    sendApprovalRequest: vi.fn().mockResolvedValue("msg-2"),
    onMessage: vi.fn(),
  }
}

describe("ChannelAdapterRegistry", () => {
  it("registers and retrieves an adapter", () => {
    const registry = new ChannelAdapterRegistry()
    const adapter = createMockAdapter("telegram")

    registry.register(adapter)

    expect(registry.get("telegram")).toBe(adapter)
  })

  it("returns undefined for unregistered adapter", () => {
    const registry = new ChannelAdapterRegistry()
    expect(registry.get("whatsapp")).toBeUndefined()
  })

  it("throws when registering a duplicate channelType", () => {
    const registry = new ChannelAdapterRegistry()
    registry.register(createMockAdapter("telegram"))

    expect(() => registry.register(createMockAdapter("telegram"))).toThrow("already registered")
  })

  it("getAll returns all registered adapters", () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")

    registry.register(tg)
    registry.register(dc)

    const all = registry.getAll()
    expect(all).toHaveLength(2)
    expect(all).toContain(tg)
    expect(all).toContain(dc)
  })

  it("startAll calls start() on every adapter", async () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")

    registry.register(tg)
    registry.register(dc)

    await registry.startAll()

    expect(tg.start).toHaveBeenCalledOnce()
    expect(dc.start).toHaveBeenCalledOnce()
  })

  it("stopAll calls stop() on every adapter (graceful — uses allSettled)", async () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")
    dc.stop.mockRejectedValue(new Error("boom"))

    registry.register(tg)
    registry.register(dc)

    // Should not throw even though discord.stop rejects
    await registry.stopAll()

    expect(tg.stop).toHaveBeenCalledOnce()
    expect(dc.stop).toHaveBeenCalledOnce()
  })

  it("healthCheckAll returns a map of channelType → boolean", async () => {
    const registry = new ChannelAdapterRegistry()
    registry.register(createMockAdapter("telegram", true))
    registry.register(createMockAdapter("discord", false))

    const results = await registry.healthCheckAll()

    expect(results.get("telegram")).toBe(true)
    expect(results.get("discord")).toBe(false)
  })

  it("healthCheckAll marks adapter as unhealthy if healthCheck throws", async () => {
    const registry = new ChannelAdapterRegistry()
    const broken = createMockAdapter("telegram")
    broken.healthCheck.mockRejectedValue(new Error("connection lost"))

    registry.register(broken)

    const results = await registry.healthCheckAll()
    expect(results.get("telegram")).toBe(false)
  })
})
