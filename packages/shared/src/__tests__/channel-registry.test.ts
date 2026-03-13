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
  it("registers and retrieves an adapter", async () => {
    const registry = new ChannelAdapterRegistry()
    const adapter = createMockAdapter("telegram")

    await registry.register(adapter)

    expect(registry.get("telegram")).toBe(adapter)
  })

  it("calls adapter.start() when registering", async () => {
    const registry = new ChannelAdapterRegistry()
    const adapter = createMockAdapter("telegram")

    await registry.register(adapter)

    expect(adapter.start).toHaveBeenCalledOnce()
  })

  it("returns undefined for unregistered adapter", () => {
    const registry = new ChannelAdapterRegistry()
    expect(registry.get("whatsapp")).toBeUndefined()
  })

  it("throws when registering a duplicate channelType", async () => {
    const registry = new ChannelAdapterRegistry()
    await registry.register(createMockAdapter("telegram"))

    await expect(registry.register(createMockAdapter("telegram"))).rejects.toThrow(
      "already registered",
    )
  })

  it("getAll returns all registered adapters", async () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")

    await registry.register(tg)
    await registry.register(dc)

    const all = registry.getAll()
    expect(all).toHaveLength(2)
    expect(all).toContain(tg)
    expect(all).toContain(dc)
  })

  it("startAll is a safe no-op (adapters already started on register)", async () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")

    await registry.register(tg)
    await registry.register(dc)

    // Reset start mocks to verify startAll does NOT call start again
    tg.start.mockClear()
    dc.start.mockClear()

    await registry.startAll()

    expect(tg.start).not.toHaveBeenCalled()
    expect(dc.start).not.toHaveBeenCalled()
  })

  it("stopAll calls stop() on every adapter (graceful — uses allSettled)", async () => {
    const registry = new ChannelAdapterRegistry()
    const tg = createMockAdapter("telegram")
    const dc = createMockAdapter("discord")
    dc.stop.mockRejectedValue(new Error("boom"))

    await registry.register(tg)
    await registry.register(dc)

    // Should not throw even though discord.stop rejects
    await registry.stopAll()

    expect(tg.stop).toHaveBeenCalledOnce()
    expect(dc.stop).toHaveBeenCalledOnce()
  })

  it("healthCheckAll returns a map of channelType → boolean", async () => {
    const registry = new ChannelAdapterRegistry()
    await registry.register(createMockAdapter("telegram", true))
    await registry.register(createMockAdapter("discord", false))

    const results = await registry.healthCheckAll()

    expect(results.get("telegram")).toBe(true)
    expect(results.get("discord")).toBe(false)
  })

  it("healthCheckAll marks adapter as unhealthy if healthCheck throws", async () => {
    const registry = new ChannelAdapterRegistry()
    const broken = createMockAdapter("telegram")
    broken.healthCheck.mockRejectedValue(new Error("connection lost"))

    await registry.register(broken)

    const results = await registry.healthCheckAll()
    expect(results.get("telegram")).toBe(false)
  })

  describe("replace", () => {
    it("replaces an existing adapter, stops the old one, and starts the new one", async () => {
      const registry = new ChannelAdapterRegistry()
      const old = createMockAdapter("telegram")
      const replacement = createMockAdapter("telegram")

      await registry.register(old)
      const returned = await registry.replace(replacement)

      expect(returned).toBe(old)
      expect(old.stop).toHaveBeenCalledOnce()
      expect(replacement.start).toHaveBeenCalledOnce()
      expect(registry.get("telegram")).toBe(replacement)
    })

    it("registers a new adapter when none exists for that type", async () => {
      const registry = new ChannelAdapterRegistry()
      const adapter = createMockAdapter("telegram")

      const returned = await registry.replace(adapter)

      expect(returned).toBeUndefined()
      expect(adapter.start).toHaveBeenCalledOnce()
      expect(registry.get("telegram")).toBe(adapter)
    })
  })

  describe("remove", () => {
    it("removes and stops an existing adapter", async () => {
      const registry = new ChannelAdapterRegistry()
      const adapter = createMockAdapter("telegram")
      await registry.register(adapter)

      const removed = await registry.remove("telegram")

      expect(removed).toBe(adapter)
      expect(adapter.stop).toHaveBeenCalledOnce()
      expect(registry.get("telegram")).toBeUndefined()
      expect(registry.getAll()).toHaveLength(0)
    })

    it("returns undefined when removing a non-existent adapter", async () => {
      const registry = new ChannelAdapterRegistry()
      const removed = await registry.remove("whatsapp")
      expect(removed).toBeUndefined()
    })
  })
})
