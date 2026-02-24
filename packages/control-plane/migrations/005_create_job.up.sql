-- 005: Create job table — application-level job state machine

CREATE TABLE job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  session_id      UUID REFERENCES session(id) ON DELETE SET NULL,
  status          job_status NOT NULL DEFAULT 'PENDING',
  priority        INTEGER NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL,
  result          JSONB,
  checkpoint      JSONB,
  checkpoint_crc  INTEGER,
  error           JSONB,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ
);

-- Queue scanning index for Graphile Worker
CREATE INDEX idx_job_status_priority ON job (status, priority DESC)
  WHERE status IN ('PENDING', 'SCHEDULED', 'RUNNING');

CREATE INDEX idx_job_agent ON job (agent_id);
CREATE INDEX idx_job_session ON job (session_id) WHERE session_id IS NOT NULL;
