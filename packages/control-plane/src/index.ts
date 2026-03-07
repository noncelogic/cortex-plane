import { DiscordAdapter } from "@cortex/adapter-discord"
import { TelegramAdapter } from "@cortex/adapter-telegram"
import { ChannelAdapterRegistry, ChannelSupervisor, MessageRouter } from "@cortex/shared/channels"
import { initTracing, shutdownTracing } from "@cortex/shared/tracing"
import { GatewayIntentBits } from "discord.js"

import { buildApp } from "./app.js"
import { AgentChannelService } from "./channels/agent-channel-service.js"
import { ChannelConfigService } from "./channels/channel-config-service.js"
import { ChannelReloader } from "./channels/channel-reloader.js"
import { createMessageDispatch } from "./channels/message-dispatch.js"
import { KyselyRouterDb } from "./channels/router-db.js"
import { loadConfig } from "./config.js"
import { runMigrations } from "./db/auto-migrate.js"
import { createDatabase } from "./db/index.js"

const config = loadConfig()

// Initialize tracing before anything else
initTracing({
  enabled: config.tracing.enabled,
  serviceName: config.tracing.serviceName,
  endpoint: config.tracing.endpoint,
  sampleRate: config.tracing.sampleRate,
  exporterType: config.tracing.exporterType,
})

const { db, pool } = createDatabase(config.databaseUrl)

// Run pending migrations before starting the app
await runMigrations(pool)

// ---------------------------------------------------------------------------
// Channel adapters — instantiate from config, create registry + supervisor
// ---------------------------------------------------------------------------
const registry = new ChannelAdapterRegistry()

// Prefer DB-backed channel configs when encryption/auth key is available;
// fall back to env-only config for bootstrap/dev.
if (config.auth?.credentialMasterKey) {
  const channelConfigService = new ChannelConfigService(db, config.auth.credentialMasterKey)
  const enabledChannels = await channelConfigService.listEnabled()

  for (const channel of enabledChannels) {
    if (channel.type === "telegram") {
      const botToken = typeof channel.config.botToken === "string" ? channel.config.botToken : ""
      if (!botToken) continue

      const allowed = channel.config.allowedUsers
      const allowedUsers = new Set<number>(
        Array.isArray(allowed)
          ? allowed.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)
          : [],
      )

      registry.register(
        new TelegramAdapter({
          botToken,
          allowedUsers,
        }),
      )
      continue
    }

    if (channel.type === "discord") {
      const token = typeof channel.config.token === "string" ? channel.config.token : ""
      if (!token) continue

      const guildIds = Array.isArray(channel.config.guildIds)
        ? channel.config.guildIds.map((g) => String(g)).filter((g) => g.length > 0)
        : []

      registry.register(
        new DiscordAdapter({
          botToken: token,
          applicationId: process.env.CHANNEL_DISCORD_APPLICATION_ID ?? "",
          allowedGuilds: new Set(guildIds),
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.MessageContent,
          ],
        }),
      )
    }
  }
}

// Per-channel-type env-var fallback: only used when no DB config exists for
// that specific type.  This allows DB-driven telegram + env-driven discord
// (or vice versa) to coexist.  Fixes #430.
if (!registry.get("telegram") && config.channels.telegram) {
  registry.register(
    new TelegramAdapter({
      botToken: config.channels.telegram.botToken,
      allowedUsers: config.channels.telegram.allowedUsers,
    }),
  )
}

if (!registry.get("discord") && config.channels.discord) {
  registry.register(
    new DiscordAdapter({
      botToken: config.channels.discord.token,
      applicationId: process.env.CHANNEL_DISCORD_APPLICATION_ID ?? "",
      allowedGuilds: new Set(config.channels.discord.guildIds),
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
    }),
  )
}

// Deferred enqueueJob — resolved after buildApp() creates workerUtils
// eslint-disable-next-line prefer-const
let _enqueueJob: ((jobId: string) => Promise<void>) | undefined
const enqueueJobDeferred = async (jobId: string): Promise<void> => {
  if (!_enqueueJob) throw new Error("enqueueJob not yet initialized — buildApp() not called")
  return _enqueueJob(jobId)
}

// Always create routing + supervision infrastructure so adapters can be
// added at runtime via the channel config API (fixes #430).
const adapterMap = new Map(registry.getAll().map((a) => [a.channelType, a]))
const routerDb = new KyselyRouterDb(db)
const messageRouter = new MessageRouter(routerDb, adapterMap)

const agentChannelService = new AgentChannelService(db)
const dispatch = createMessageDispatch({
  db,
  agentChannelService,
  router: messageRouter,
  enqueueJob: enqueueJobDeferred,
})
messageRouter.onMessage(dispatch)
messageRouter.bind()

const channelSupervisor = new ChannelSupervisor(registry, {
  telegram: { connectionMode: "long-poll" },
  discord: { connectionMode: "websocket" },
})

// Channel reloader — hot-reloads adapters when channel configs change via API
let channelReloader: ChannelReloader | undefined
if (config.auth?.credentialMasterKey) {
  const reloaderConfigService = new ChannelConfigService(db, config.auth.credentialMasterKey)
  channelReloader = new ChannelReloader({
    registry,
    supervisor: channelSupervisor,
    router: messageRouter,
    channelConfigService: reloaderConfigService,
  })
}

const { app, enqueueJob } = await buildApp({
  db,
  pool,
  config,
  channelSupervisor,
  channelReloader,
})
_enqueueJob = enqueueJob

// Shutdown tracing on app close
app.addHook("onClose", async () => {
  await shutdownTracing()
})

try {
  const address = await app.listen({ port: config.port, host: config.host })
  app.log.info(`Control plane listening on ${address}`)
} catch (err) {
  app.log.fatal(err)
  await shutdownTracing()
  process.exit(1)
}
