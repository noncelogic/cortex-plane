-- Channel configuration table — stores DB-backed config for channel adapters
-- (Telegram, Discord, WhatsApp) with encrypted sensitive fields.

CREATE TABLE channel_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,                    -- telegram | discord | whatsapp
  name          TEXT NOT NULL,                    -- human-readable label
  config_enc    TEXT NOT NULL,                    -- AES-256-GCM encrypted JSONB (bot tokens, guild IDs, etc.)
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES user_account(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_config_type ON channel_config (type);
CREATE INDEX idx_channel_config_enabled ON channel_config (enabled) WHERE enabled = true;
