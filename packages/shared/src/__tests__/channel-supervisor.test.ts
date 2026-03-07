import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ChannelAdapterRegistry } from "../channels/registry.js"
import { ChannelSupervisor } from "../channels/supervisor.js"
import type { ChannelAdapter } from "../channels/types.js"

interface MockAdapter extends ChannelAdapter {
  startSpy: ReturnType<typeof vi.fn>
  stopSpy: ReturnType<typeof vi.fn>
  setHealth: (healthy: boolean) => void
  setLastHeartbeatAt: (date: Date | undefined) => void
}

function createAdapter(channelType: string): MockAdapter {
  let healthy = true
  let lastHeartbeatAt: Date | undefined
  const startSpy = vi.fn().mockResolvedValue(undefined)
  const stopSpy = vi.fn().mockResolvedValue(undefined)

  return {
    channelType,
    startSpy,
    stopSpy,
    start: startSpy,
    stop: stopSpy,
    healthCheck: vi.fn().mockImplementation(() => Promise.resolve(healthy)),
    sendMessage: vi.fn().mockResolvedValue("msg-id"),
    sendApprovalRequest: vi.fn().mockResolvedValue("approval-id"),
    onMessage: vi.fn(),
    getLastHeartbeatAt: vi.fn().mockImplementation(() => lastHeartbeatAt),
    setHealth: (nextHealthy: boolean) => {
      healthy = nextHealthy
    },
    setLastHeartbeatAt: (date: Date | undefined) => {
      lastHeartbeatAt = date
    },
  }
}

describe("ChannelSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-27T00:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("restarts only the failing adapter", async () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = createAdapter("telegram")
    const discord = createAdapter("discord")
    registry.register(telegram)
    registry.register(discord)

    const supervisor = new ChannelSupervisor(
      registry,
      { telegram: { connectionMode: "long-poll" }, discord: { connectionMode: "websocket" } },
      {
        probeIntervalMs: 500,
        initialBackoffMs: 100,
        maxBackoffMs: 400,
        jitterRatio: 0,
        random: () => 0.5,
      },
    )

    supervisor.start()
    telegram.setHealth(false)

    await vi.advanceTimersByTimeAsync(750)

    expect(telegram.stopSpy).toHaveBeenCalled()
    expect(telegram.startSpy).toHaveBeenCalled()
    expect(discord.stopSpy).not.toHaveBeenCalled()
    expect(discord.startSpy).not.toHaveBeenCalled()

    supervisor.stop()
  })

  it("marks long-poll adapters as stale and recovers when heartbeat is too old", async () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = createAdapter("telegram")
    registry.register(telegram)
    telegram.setLastHeartbeatAt(new Date("2026-02-26T23:58:00.000Z"))

    const supervisor = new ChannelSupervisor(
      registry,
      { telegram: { connectionMode: "long-poll", staleAfterMs: 30_000 } },
      {
        probeIntervalMs: 1_000,
        initialBackoffMs: 100,
        maxBackoffMs: 200,
        jitterRatio: 0,
        random: () => 0.5,
      },
    )

    const snapshots: string[] = []
    const unsubscribe = supervisor.subscribe((statuses) => {
      const telegram = statuses.find((status) => status.channelType === "telegram")
      if (telegram?.lastError) {
        snapshots.push(telegram.lastError)
      }
    })

    supervisor.start()
    await vi.advanceTimersByTimeAsync(1_200)

    const status = supervisor.getStatus("telegram")
    expect(status).toBeDefined()
    expect(snapshots.some((error) => error.includes("stale_connection_long-poll"))).toBe(true)
    expect(telegram.stopSpy).toHaveBeenCalled()
    expect(telegram.startSpy).toHaveBeenCalled()

    unsubscribe()
    supervisor.stop()
  })

  it("uses exponential backoff and opens circuit after repeated failures", async () => {
    const registry = new ChannelAdapterRegistry()
    const telegram = createAdapter("telegram")
    ;(telegram.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    registry.register(telegram)

    const supervisor = new ChannelSupervisor(
      registry,
      { telegram: { connectionMode: "long-poll" } },
      {
        probeIntervalMs: 10_000,
        initialBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        random: () => 0.5,
        circuitFailureThreshold: 3,
        circuitOpenMs: 500,
      },
    )

    telegram.setHealth(false)
    supervisor.start()

    await vi.advanceTimersByTimeAsync(1_000)

    const status = supervisor.getStatus("telegram")
    expect(status).toBeDefined()
    expect(status!.state).toBe("circuit_open")
    expect(status!.consecutiveFailures).toBeGreaterThanOrEqual(3)
    expect(telegram.stopSpy).toHaveBeenCalled()
    expect(telegram.startSpy).toHaveBeenCalled()

    supervisor.stop()
  })

  describe("addAdapter", () => {
    it("creates a health status for a dynamically added adapter", async () => {
      const registry = new ChannelAdapterRegistry()
      const supervisor = new ChannelSupervisor(registry, {}, { probeIntervalMs: 10_000 })

      supervisor.start()

      // No adapters initially
      expect(supervisor.getAllStatuses()).toHaveLength(0)

      // Add a new adapter to the registry and notify the supervisor
      const telegram = createAdapter("telegram")
      registry.register(telegram)
      supervisor.addAdapter("telegram", { connectionMode: "long-poll" })

      // Status should now exist
      const statuses = supervisor.getAllStatuses()
      expect(statuses).toHaveLength(1)
      expect(statuses[0]!.channelType).toBe("telegram")

      supervisor.stop()
    })

    it("emits to listeners when a new adapter is added", () => {
      const registry = new ChannelAdapterRegistry()
      const supervisor = new ChannelSupervisor(registry, {}, { probeIntervalMs: 10_000 })

      const telegram = createAdapter("telegram")
      registry.register(telegram)

      const listener = vi.fn()
      supervisor.subscribe(listener)

      supervisor.addAdapter("telegram")

      // Listener should have been called with the new status
      const lastCall = listener.mock.calls[listener.mock.calls.length - 1]!
      expect(lastCall[0]).toHaveLength(1)
      expect(lastCall[0]![0]!.channelType).toBe("telegram")
    })
  })

  describe("removeAdapter", () => {
    it("clears health status for a removed adapter", async () => {
      const registry = new ChannelAdapterRegistry()
      const telegram = createAdapter("telegram")
      registry.register(telegram)

      const supervisor = new ChannelSupervisor(
        registry,
        { telegram: { connectionMode: "long-poll" } },
        { probeIntervalMs: 10_000 },
      )

      supervisor.start()
      expect(supervisor.getStatus("telegram")).toBeDefined()

      await registry.remove("telegram")
      supervisor.removeAdapter("telegram")

      expect(supervisor.getStatus("telegram")).toBeUndefined()

      supervisor.stop()
    })

    it("emits to listeners when an adapter is removed", async () => {
      const registry = new ChannelAdapterRegistry()
      const telegram = createAdapter("telegram")
      registry.register(telegram)

      const supervisor = new ChannelSupervisor(
        registry,
        { telegram: { connectionMode: "long-poll" } },
        { probeIntervalMs: 10_000 },
      )

      supervisor.start()

      const listener = vi.fn()
      supervisor.subscribe(listener)

      await registry.remove("telegram")
      supervisor.removeAdapter("telegram")

      // Last listener call should have empty statuses
      const lastCall = listener.mock.calls[listener.mock.calls.length - 1]!
      expect(lastCall[0]).toHaveLength(0)

      supervisor.stop()
    })
  })
})
