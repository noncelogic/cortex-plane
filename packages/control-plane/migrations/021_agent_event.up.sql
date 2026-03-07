-- 021: Create agent_event table for operator-visible agent activity stream.
--      Part of the operator visibility epic (#265-T1).

CREATE TABLE agent_event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  job_id          UUID REFERENCES job(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  cost_usd        NUMERIC(12, 6),
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ae_agent   ON agent_event(agent_id, created_at DESC);
CREATE INDEX idx_ae_created ON agent_event(created_at);
