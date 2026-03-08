-- Channel-level user allowlist for inbound messaging (#436).
-- Adds an inbound_policy column to channel_config and a new
-- channel_allowlist table with audit trail.

-- Policy column: controls whether the channel accepts all users or only
-- those explicitly added to its allowlist.
ALTER TABLE channel_config
  ADD COLUMN inbound_policy TEXT NOT NULL DEFAULT 'open';

-- Channel-level allowlist entries.
CREATE TABLE channel_allowlist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_config_id UUID NOT NULL REFERENCES channel_config(id) ON DELETE CASCADE,
  platform_user_id  TEXT NOT NULL,
  display_name      TEXT,
  note              TEXT,
  added_by          UUID REFERENCES user_account(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_config_id, platform_user_id)
);

CREATE INDEX idx_channel_allowlist_channel ON channel_allowlist (channel_config_id);

-- Audit log for allowlist changes.
CREATE TABLE channel_allowlist_audit (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_config_id UUID NOT NULL REFERENCES channel_config(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  platform_user_id  TEXT,
  performed_by      UUID REFERENCES user_account(id),
  detail            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_allowlist_audit_channel ON channel_allowlist_audit (channel_config_id, created_at DESC);
