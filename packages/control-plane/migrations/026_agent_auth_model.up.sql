-- 026: Agent auth model enum + user usage ledger.
--      Part of the channel-authorization epic (#333).
--      Adds the per-agent authorization model column and
--      periodic usage aggregation table.

-- 1. agent_auth_model enum
CREATE TYPE agent_auth_model AS ENUM (
  'allowlist',
  'approval_queue',
  'team',
  'open'
);

-- 2. Add auth_model column to agent (defaults existing rows to 'allowlist')
ALTER TABLE agent
  ADD COLUMN auth_model agent_auth_model NOT NULL DEFAULT 'allowlist';

-- 3. user_usage_ledger — periodic per-user per-agent usage aggregation
CREATE TABLE user_usage_ledger (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID           NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  agent_id        UUID           NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  period_start    TIMESTAMPTZ    NOT NULL,
  period_end      TIMESTAMPTZ    NOT NULL,
  messages_sent   INTEGER        NOT NULL DEFAULT 0,
  tokens_in       INTEGER        NOT NULL DEFAULT 0,
  tokens_out      INTEGER        NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

  UNIQUE (user_account_id, agent_id, period_start),
  CHECK  (period_end > period_start)
);

CREATE INDEX idx_uul_agent_period
  ON user_usage_ledger (agent_id, period_start DESC);

CREATE INDEX idx_uul_user_period
  ON user_usage_ledger (user_account_id, period_start DESC);
