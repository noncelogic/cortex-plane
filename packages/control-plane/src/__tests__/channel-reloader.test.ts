import type { ChannelAdapter } from "@cortex/shared/channels"
import { ChannelAdapterRegistry, ChannelSupervisor, MessageRouter } from "@cortex/shared/channels"
import { describe, expect, it, vi } from "vitest"

import type { ChannelConfigFull, ChannelConfigService } from "../channels/channel-config-service.js"
import { ChannelReloader } from "../channels/channel-reloader.js"

// ---------------------------------------------------------------------------
// Mocks — stub adapter packages so we don't need real grammy / discord.js
// ---------------------------------------------------------------------------
const mockTelegramStart = vi.fn().mockResolvedValue(undefined)
const mockTelegramStop = vi.fn().mockResolvedValue(undefined)

vi.mock("@cortex/adapter-telegram", () => ({
  TelegramAdapter: vi.fn().mockImplementation((config: { botToken: string }) => ({
    channelType: "telegram",
    botToken: config.botToken,
    start: mockTelegramStart,
    stop: mockTelegramStop,
    healthCheck: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue("msg-1"),
    sendApprovalRequest: vi.fn().mockResolvedValue("msg-2"),
    onMessage: vi.fn(),
  })),
}))

vi.mock("@cortex/adapter-discord", () => ({
  DiscordAdapter: vi.fn().mockImplementation(() => ({
    channelType: "discord",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue("msg-1"),
    sendApprovalRequest: vi.fn().mockResolvedValue("msg-2"),
    onMessage: vi.fn(),
  })),
}))

vi.mock("discord.js", () => ({
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    GuildMessageReactions: 4,
    MessageContent: 8,
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockConfigService(enabledConfigs: ChannelConfigFull[] = []) {
  return {
    listEnabled: vi.fn().mockResolvedValue(enabledConfigs),
    list: vi.fn(),
    getById: vi.fn(),
    getByIdFull: vi.fn(),
    findByTypeName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getBindingsByChannelType: vi.fn(),
    removeBindingsByChannelType: vi.fn(),
  } as unknown as ChannelConfigService
}

function makeTelegramConfig(overrides: Partial<ChannelConfigFull> = {}): ChannelConfigFull {
  return {
    id: "cfg-1",
    type: "telegram",
    name: "default-tg",
    enabled: true,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    config: { botToken: "fake-token-123" },
    ...overrides,
  }
}

function createMockRouterDb() {
  return {
    resolveUser: vi.fn(),
    createUser: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelReloader", () => {
  it("starts a new adapter when an enabled config is found", async () => {
    const registry = new ChannelAdapterRegistry()
    const router = new MessageRouter(createMockRouterDb(), new Map())
    const supervisor = new ChannelSupervisor(registry, {}, { probeIntervalMs: 60_000 })
    const configService = createMockConfigService([makeTelegramConfig()])

    const reloader = new ChannelReloader({
      registry,
      supervisor,
      router,
      channelConfigService: configService,
    })

    await reloader.syncChannelType("telegram")

    // Adapter should be registered and started
    const adapter = registry.get("telegram")
    expect(adapter).toBeDefined()
    expect(mockTelegramStart).toHaveBeenCalled()

    // Supervisor should have health status
    expect(supervisor.getStatus("telegram")).toBeDefined()
  })

  it("tears down existing adapter and replaces with new one on config change", async () => {
    const registry = new ChannelAdapterRegistry()
    const router = new MessageRouter(createMockRouterDb(), new Map())
    const supervisor = new ChannelSupervisor(registry, {}, { probeIntervalMs: 60_000 })

    // First: register an initial adapter
    const oldStopSpy = vi.fn().mockResolvedValue(undefined)
    const oldAdapter: ChannelAdapter = {
      channelType: "telegram",
      start: vi.fn().mockResolvedValue(undefined),
      stop: oldStopSpy,
      healthCheck: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue("msg-1"),
      sendApprovalRequest: vi.fn().mockResolvedValue("msg-2"),
      onMessage: vi.fn(),
    }
    registry.register(oldAdapter)
    router.addAdapter(oldAdapter)
    supervisor.addAdapter("telegram")

    // Config returns a new telegram config (updated token)
    const configService = createMockConfigService([
      makeTelegramConfig({ config: { botToken: "new-token-456" } }),
    ])

    const reloader = new ChannelReloader({
      registry,
      supervisor,
      router,
      channelConfigService: configService,
    })

    mockTelegramStart.mockClear()
    await reloader.syncChannelType("telegram")

    // Old adapter should have been stopped (via registry.remove)
    expect(oldStopSpy).toHaveBeenCalled()

    // New adapter should be registered
    const newAdapter = registry.get("telegram")
    expect(newAdapter).toBeDefined()
    expect(newAdapter).not.toBe(oldAdapter)
    expect(mockTelegramStart).toHaveBeenCalled()
  })

  it("tears down adapter when channel type is disabled/deleted", async () => {
    const registry = new ChannelAdapterRegistry()
    const router = new MessageRouter(createMockRouterDb(), new Map())
    const supervisor = new ChannelSupervisor(registry, {}, { probeIntervalMs: 60_000 })

    const stopSpy = vi.fn().mockResolvedValue(undefined)
    const adapter: ChannelAdapter = {
      channelType: "telegram",
      start: vi.fn().mockResolvedValue(undefined),
      stop: stopSpy,
      healthCheck: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue("msg-1"),
      sendApprovalRequest: vi.fn().mockResolvedValue("msg-2"),
      onMessage: vi.fn(),
    }
    registry.register(adapter)
    router.addAdapter(adapter)
    supervisor.addAdapter("telegram")

    // Config returns empty — channel was deleted
    const configService = createMockConfigService([])

    const reloader = new ChannelReloader({
      registry,
      supervisor,
      router,
      channelConfigService: configService,
    })

    await reloader.syncChannelType("telegram")

    // Adapter should be gone
    expect(registry.get("telegram")).toBeUndefined()
    expect(stopSpy).toHaveBeenCalled()
    expect(supervisor.getStatus("telegram")).toBeUndefined()
  })

  it("is a no-op when no config exists and no adapter is running", async () => {
    const registry = new ChannelAdapterRegistry()
    const configService = createMockConfigService([])

    const reloader = new ChannelReloader({
      registry,
      channelConfigService: configService,
    })

    // Should not throw
    await reloader.syncChannelType("telegram")
    expect(registry.getAll()).toHaveLength(0)
  })

  it("skips adapter creation when config has empty botToken", async () => {
    const registry = new ChannelAdapterRegistry()
    const configService = createMockConfigService([
      makeTelegramConfig({ config: { botToken: "" } }),
    ])

    const reloader = new ChannelReloader({
      registry,
      channelConfigService: configService,
    })

    await reloader.syncChannelType("telegram")
    expect(registry.get("telegram")).toBeUndefined()
  })
})
