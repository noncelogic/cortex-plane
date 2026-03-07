-- 022: Channel authorization — pairing codes and user grants.
--      Part of the channel-authorization epic (#333).
--      Dependency for PairingService (#336).

-- 1. Enums
CREATE TYPE grant_access_level AS ENUM ('read', 'write');
CREATE TYPE grant_origin AS ENUM (
  'pairing_code',
  'dashboard_invite',
  'auto_team',
  'auto_open',
  'approval'
);

-- 2. pairing_code
CREATE TABLE pairing_code (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT        NOT NULL UNIQUE,
  agent_id    UUID        REFERENCES agent(id) ON DELETE CASCADE,
  created_by  UUID        NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  redeemed_by UUID        REFERENCES user_account(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_code_active
  ON pairing_code (code)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- 3. agent_user_grant
CREATE TABLE agent_user_grant (
  id              UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID               NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  user_account_id UUID               NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  access_level    grant_access_level  NOT NULL DEFAULT 'write',
  origin          grant_origin        NOT NULL,
  granted_by      UUID               REFERENCES user_account(id) ON DELETE SET NULL,
  rate_limit      JSONB,
  token_budget    JSONB,
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ        NOT NULL DEFAULT now(),
  UNIQUE (agent_id, user_account_id)
);

CREATE INDEX idx_aug_agent ON agent_user_grant (agent_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_aug_user  ON agent_user_grant (user_account_id) WHERE revoked_at IS NULL;
