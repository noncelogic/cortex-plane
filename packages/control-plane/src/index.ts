import { DiscordAdapter } from "@cortex/adapter-discord"
import { TelegramAdapter } from "@cortex/adapter-telegram"
import { ChannelAdapterRegistry, ChannelSupervisor, MessageRouter } from "@cortex/shared/channels"
import { initTracing, shutdownTracing } from "@cortex/shared/tracing"
import { GatewayIntentBits } from "discord.js"

import { buildApp } from "./app.js"
import { AgentChannelService } from "./channels/agent-channel-service.js"
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
let channelSupervisor: ChannelSupervisor | undefined

const registry = new ChannelAdapterRegistry()

if (config.channels.telegram) {
  const adapter = new TelegramAdapter({
    botToken: config.channels.telegram.botToken,
    allowedUsers: config.channels.telegram.allowedUsers,
  })
  registry.register(adapter)
}

if (config.channels.discord) {
  const adapter = new DiscordAdapter({
    botToken: config.channels.discord.token,
    applicationId: process.env.CHANNEL_DISCORD_APPLICATION_ID ?? "",
    allowedGuilds: new Set(config.channels.discord.guildIds),
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
  })
  registry.register(adapter)
}

// Deferred enqueueJob — resolved after buildApp() creates workerUtils
let _enqueueJob: ((jobId: string) => Promise<void>) | undefined
const enqueueJobDeferred = async (jobId: string): Promise<void> => {
  if (!_enqueueJob) throw new Error("enqueueJob not yet initialized — buildApp() not called")
  return _enqueueJob(jobId)
}

if (registry.getAll().length > 0) {
  // Build adapter map for the MessageRouter
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

  channelSupervisor = new ChannelSupervisor(registry, {
    telegram: { connectionMode: "long-poll" },
    discord: { connectionMode: "websocket" },
  })
}

const { app, enqueueJob } = await buildApp({ db, pool, config, channelSupervisor })
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
