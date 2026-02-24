-- 003: Create unified user identity tables

CREATE TABLE user_account (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_mapping (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_type, channel_user_id),
  CHECK (channel_type = lower(channel_type))
);

CREATE INDEX idx_channel_mapping_user ON channel_mapping (user_account_id);
