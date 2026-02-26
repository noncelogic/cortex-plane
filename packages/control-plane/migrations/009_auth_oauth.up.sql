-- 009: Dashboard OAuth authentication + provider credential management
-- Extends user_account for OAuth login, adds encrypted credential storage,
-- dashboard sessions, and credential audit trail.

-- Role enum for dashboard users
CREATE TYPE user_role AS ENUM ('operator', 'approver', 'admin');

-- Extend user_account with OAuth identity fields
ALTER TABLE user_account ADD COLUMN email TEXT UNIQUE;
ALTER TABLE user_account ADD COLUMN avatar_url TEXT;
ALTER TABLE user_account ADD COLUMN role user_role NOT NULL DEFAULT 'operator';
ALTER TABLE user_account ADD COLUMN oauth_provider TEXT;          -- 'google' | 'github'
ALTER TABLE user_account ADD COLUMN oauth_provider_id TEXT;       -- external user ID
ALTER TABLE user_account ADD COLUMN encryption_key_enc TEXT;      -- per-user encryption key (encrypted by master key)
ALTER TABLE user_account ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Unique constraint: one account per OAuth provider+provider_id pair
CREATE UNIQUE INDEX idx_user_oauth_identity ON user_account (oauth_provider, oauth_provider_id)
  WHERE oauth_provider IS NOT NULL;

-- Dashboard session — httpOnly cookie-backed sessions
CREATE TABLE dashboard_session (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  csrf_token      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  refresh_token   TEXT,                    -- hashed refresh token for token rotation
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dashboard_session_user ON dashboard_session (user_account_id);
CREATE INDEX idx_dashboard_session_expires ON dashboard_session (expires_at);

-- Provider credentials — encrypted at rest (AES-256-GCM)
-- Stores both OAuth tokens and API keys for LLM providers.
CREATE TABLE provider_credential (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,            -- 'google-antigravity', 'openai-codex', 'anthropic', 'openai', 'google-ai-studio'
  credential_type TEXT NOT NULL,            -- 'oauth' | 'api_key'
  -- Encrypted fields (AES-256-GCM, per-user key)
  access_token_enc  TEXT,                   -- encrypted access token
  refresh_token_enc TEXT,                   -- encrypted refresh token (OAuth only)
  api_key_enc       TEXT,                   -- encrypted API key (api_key type only)
  -- Token metadata (not sensitive, stored in plaintext for queries)
  token_expires_at  TIMESTAMPTZ,            -- OAuth token expiry
  scopes            TEXT[],                 -- granted OAuth scopes
  account_id        TEXT,                   -- external account/project ID
  display_label     TEXT,                   -- user-visible label ("Work account")
  status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'revoked' | 'error'
  last_used_at      TIMESTAMPTZ,
  last_refresh_at   TIMESTAMPTZ,
  error_count       INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_account_id, provider, display_label)
);

CREATE INDEX idx_provider_cred_user ON provider_credential (user_account_id);
CREATE INDEX idx_provider_cred_provider ON provider_credential (user_account_id, provider);

-- Credential audit log — tracks all credential lifecycle events
CREATE TABLE credential_audit_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id       UUID REFERENCES user_account(id) ON DELETE SET NULL,
  provider_credential_id UUID REFERENCES provider_credential(id) ON DELETE SET NULL,
  event_type            TEXT NOT NULL,       -- 'credential_created', 'credential_updated', 'credential_deleted',
                                             -- 'token_refreshed', 'token_expired', 'api_key_rotated',
                                             -- 'oauth_connected', 'oauth_disconnected', 'login', 'logout'
  provider              TEXT,
  details               JSONB NOT NULL DEFAULT '{}',
  ip_address            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cred_audit_user ON credential_audit_log (user_account_id, created_at DESC);
CREATE INDEX idx_cred_audit_credential ON credential_audit_log (provider_credential_id, created_at DESC);
CREATE INDEX idx_cred_audit_event ON credential_audit_log (event_type, created_at DESC);
