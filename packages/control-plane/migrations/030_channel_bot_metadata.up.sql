-- Add bot_metadata column to channel_config.
-- Stores non-sensitive bot identity info (username, display name, bot ID)
-- returned by provider APIs (e.g. Telegram getMe).  Nullable — only
-- populated for channel types that support identity verification.
ALTER TABLE channel_config
  ADD COLUMN bot_metadata JSONB;
