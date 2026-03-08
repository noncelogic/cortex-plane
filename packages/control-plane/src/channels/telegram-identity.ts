/**
 * Telegram Bot Identity Verification
 *
 * Calls the Telegram Bot API `getMe` endpoint to retrieve the bot's identity
 * (username, display name, bot ID).  Uses plain `fetch` so that control-plane
 * does not need a runtime dependency on the grammy adapter package.
 */

import type { BotMetadata } from "../db/types.js"

const TELEGRAM_API_BASE = "https://api.telegram.org"

interface TelegramGetMeResponse {
  ok: boolean
  result?: {
    id: number
    is_bot: boolean
    first_name: string
    username?: string
  }
  description?: string
}

/**
 * Fetch bot identity from the Telegram Bot API.
 * Returns `BotMetadata` on success, or `undefined` if the token is invalid /
 * the API is unreachable.
 */
export async function fetchTelegramBotIdentity(botToken: string): Promise<BotMetadata | undefined> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`)
    if (!res.ok) return undefined

    const data = (await res.json()) as TelegramGetMeResponse
    if (!data.ok || !data.result) return undefined

    return {
      bot_id: String(data.result.id),
      username: data.result.username ?? "",
      display_name: data.result.first_name,
    }
  } catch {
    return undefined
  }
}
