/**
 * Channel Reloader
 *
 * Synchronises running channel adapters with DB-backed channel_config rows.
 * Called from channel routes after create / update / delete mutations so that
 * adapter lifecycle follows config changes without a process restart.
 *
 * Fixes: https://github.com/noncelogic/cortex-plane/issues/430
 */

import { DiscordAdapter } from "@cortex/adapter-discord"
import { TelegramAdapter } from "@cortex/adapter-telegram"
import type {
  ChannelAdapter,
  ChannelAdapterRegistry,
  ChannelSupervisor,
  ChannelSupervisorAdapterConfig,
  MessageRouter,
} from "@cortex/shared/channels"
import { GatewayIntentBits } from "discord.js"

import type { ChannelConfigFull, ChannelConfigService } from "./channel-config-service.js"

const ADAPTER_SUPERVISOR_CONFIG: Record<string, ChannelSupervisorAdapterConfig> = {
  telegram: { connectionMode: "long-poll" },
  discord: { connectionMode: "websocket" },
}

export interface ChannelReloaderDeps {
  registry: ChannelAdapterRegistry
  supervisor?: ChannelSupervisor
  router?: MessageRouter
  channelConfigService: ChannelConfigService
}

export class ChannelReloader {
  constructor(private readonly deps: ChannelReloaderDeps) {}

  /**
   * Re-read enabled configs for `channelType` from the DB and reconcile:
   *  - If an enabled config exists → (re)create the adapter, register, start, bind.
   *  - If no enabled config exists → tear down the running adapter (if any).
   */
  async syncChannelType(channelType: string): Promise<void> {
    const { registry, supervisor, router, channelConfigService } = this.deps

    const allEnabled = await channelConfigService.listEnabled()
    const config = allEnabled.find((c) => c.type === channelType)

    // Tear down the existing adapter (if any).
    // Order matters: remove from registry first so that the supervisor's
    // syncAdapters() (called inside emit()) does not re-create the status.
    const existing = registry.get(channelType)
    if (existing) {
      router?.removeAdapter(channelType)
      await registry.remove(channelType)
      supervisor?.removeAdapter(channelType)
    }

    if (!config) return

    const adapter = createAdapterFromConfig(config)
    if (!adapter) return

    registry.register(adapter)
    await adapter.start()
    router?.addAdapter(adapter)
    supervisor?.addAdapter(channelType, ADAPTER_SUPERVISOR_CONFIG[channelType])
  }
}

function createAdapterFromConfig(config: ChannelConfigFull): ChannelAdapter | undefined {
  if (config.type === "telegram") {
    const botToken = typeof config.config.botToken === "string" ? config.config.botToken : ""
    if (!botToken) return undefined

    const allowed = config.config.allowedUsers
    const allowedUsers = new Set<number>(
      Array.isArray(allowed)
        ? allowed.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
        : [],
    )

    return new TelegramAdapter({ botToken, allowedUsers })
  }

  if (config.type === "discord") {
    const token = typeof config.config.token === "string" ? config.config.token : ""
    if (!token) return undefined

    const guildIds = Array.isArray(config.config.guildIds)
      ? config.config.guildIds.map((g) => String(g)).filter((g) => g.length > 0)
      : []

    return new DiscordAdapter({
      botToken: token,
      applicationId: process.env.CHANNEL_DISCORD_APPLICATION_ID ?? "",
      allowedGuilds: new Set(guildIds),
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
    })
  }

  return undefined
}
