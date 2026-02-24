export interface TelegramConfig {
  botToken: string
  allowedUsers: Set<number>
}

export function loadConfig(): TelegramConfig {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"]
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required")
  }

  const allowedRaw = process.env["TELEGRAM_ALLOWED_USERS"] ?? ""
  const ids: number[] = []

  for (const part of allowedRaw.split(",")) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid user ID in TELEGRAM_ALLOWED_USERS: "${trimmed}"`)
    }
    ids.push(n)
  }

  return { botToken, allowedUsers: new Set(ids) }
}
