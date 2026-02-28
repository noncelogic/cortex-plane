import type { ChannelAdapter } from "@cortex/shared/channels"
import { ChannelAdapterRegistry, ChannelSupervisor, MessageRouter } from "@cortex/shared/channels"
import { describe, expect, it, vi } from "vitest"

import { KyselyRouterDb } from "../channels/router-db.js"

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

function mockAdapter(channelType: string): ChannelAdapter {
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue("msg-id"),
    sendApprovalRequest: vi.fn().mockResolvedValue("msg-id"),
    onMessage: vi.fn(),
    onCallback: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channel startup wiring", () => {
  it("registers adapters and creates supervisor", () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = mockAdapter("telegram")
    const discord = mockAdapter("discord")

    registry.register(telegram)
    registry.register(discord)

    expect(registry.getAll()).toHaveLength(2)
    expect(registry.get("telegram")).toBe(telegram)
    expect(registry.get("discord")).toBe(discord)

    const supervisor = new ChannelSupervisor(registry, {
      telegram: { connectionMode: "long-poll" },
      discord: { connectionMode: "websocket" },
    })

    // Supervisor starts and reports status for registered adapters
    supervisor.start()
    const statuses = supervisor.getAllStatuses()
    expect(statuses).toHaveLength(2)
    expect(statuses.map((s) => s.channelType).sort()).toEqual(["discord", "telegram"])
    supervisor.stop()
  })

  it("creates message router and binds to adapters", () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = mockAdapter("telegram")
    registry.register(telegram)

    const adapterMap = new Map(registry.getAll().map((a) => [a.channelType, a]))
    const db = {} as Parameters<typeof KyselyRouterDb.prototype.resolveUser>[0]
    const routerDb = new KyselyRouterDb(db as never)

    const router = new MessageRouter(routerDb, adapterMap)
    router.onMessage(vi.fn())
    router.bind()

    // Adapter's onMessage should have been called by bind()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(telegram.onMessage).toHaveBeenCalledTimes(1)
  })

  it("works with no adapters registered", () => {
    const registry = new ChannelAdapterRegistry()
    expect(registry.getAll()).toHaveLength(0)

    // No supervisor created when no adapters
    const supervisor = new ChannelSupervisor(registry)
    supervisor.start()
    expect(supervisor.getAllStatuses()).toHaveLength(0)
    supervisor.stop()
  })

  it("supervisor emits health updates via subscribe", () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = mockAdapter("telegram")
    registry.register(telegram)

    const supervisor = new ChannelSupervisor(registry, {
      telegram: { connectionMode: "long-poll" },
    })

    const listener = vi.fn()
    const unsubscribe = supervisor.subscribe(listener)

    // subscribe() immediately calls the listener
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ channelType: "telegram" })]),
    )

    unsubscribe()
  })
})
