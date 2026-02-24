import { GatewayIntentBits } from "discord.js"

export interface DiscordConfig {
  botToken: string
  applicationId: string
  allowedGuilds: Set<string>
  intents: GatewayIntentBits[]
}

const DEFAULT_INTENTS: GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
]

export function loadConfig(): DiscordConfig {
  const botToken = process.env["DISCORD_BOT_TOKEN"]
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN environment variable is required")
  }

  const applicationId = process.env["DISCORD_APPLICATION_ID"]
  if (!applicationId) {
    throw new Error("DISCORD_APPLICATION_ID environment variable is required")
  }

  const guildsRaw = process.env["DISCORD_ALLOWED_GUILDS"] ?? ""
  const guilds: string[] = []

  for (const part of guildsRaw.split(",")) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid guild ID in DISCORD_ALLOWED_GUILDS: "${trimmed}"`)
    }
    guilds.push(trimmed)
  }

  return {
    botToken,
    applicationId,
    allowedGuilds: new Set(guilds),
    intents: DEFAULT_INTENTS,
  }
}
