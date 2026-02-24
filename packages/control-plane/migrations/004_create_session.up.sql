-- 004: Create session table — interaction context between a user and an agent

CREATE TABLE session (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  user_account_id UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_agent ON session (agent_id);
CREATE INDEX idx_session_user ON session (user_account_id);
