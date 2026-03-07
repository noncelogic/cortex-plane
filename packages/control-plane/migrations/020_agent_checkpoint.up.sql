-- 020: Create agent_checkpoint table for persisting agent state snapshots.
--      Part of the agent lifecycle and resilience epic (#266-T6).

CREATE TABLE agent_checkpoint (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  job_id            UUID REFERENCES job(id) ON DELETE SET NULL,
  label             TEXT,
  state             JSONB NOT NULL,
  state_crc         INTEGER NOT NULL,
  context_snapshot  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX idx_acp_agent ON agent_checkpoint(agent_id, created_at DESC);
