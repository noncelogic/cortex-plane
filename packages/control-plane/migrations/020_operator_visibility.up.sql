-- 020: Operator visibility — agent_event table + job/session cost columns.
--      Part of operator-visibility epic (#320), task #265-T1.

-- 1. Create agent_event_type enum
CREATE TYPE agent_event_type AS ENUM (
  'llm_call_start',
  'llm_call_end',
  'tool_call_start',
  'tool_call_end',
  'tool_denied',
  'tool_rate_limited',
  'message_received',
  'message_sent',
  'state_transition',
  'circuit_breaker_trip',
  'cost_alert',
  'steer_injected',
  'steer_acknowledged',
  'kill_requested',
  'checkpoint_created',
  'error',
  'session_start',
  'session_end'
);

-- 2. Create agent_event table
CREATE TABLE agent_event (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES session(id) ON DELETE SET NULL,
  job_id           UUID REFERENCES job(id) ON DELETE SET NULL,
  parent_event_id  UUID REFERENCES agent_event(id) ON DELETE SET NULL,
  event_type       agent_event_type NOT NULL,
  payload          JSONB,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  cost_usd         NUMERIC(12,6),
  duration_ms      INTEGER,
  model            TEXT,
  tool_ref         TEXT,
  actor            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Indexes for agent_event
CREATE INDEX idx_agent_event_agent_created   ON agent_event (agent_id, created_at DESC);
CREATE INDEX idx_agent_event_session_created ON agent_event (session_id, created_at DESC);
CREATE INDEX idx_agent_event_job_created     ON agent_event (job_id, created_at DESC);
CREATE INDEX idx_agent_event_type_created    ON agent_event (event_type, created_at DESC);
CREATE INDEX idx_agent_event_agent_cost      ON agent_event (agent_id, cost_usd) WHERE cost_usd IS NOT NULL;

-- 4. Add cost / delegation columns to job
ALTER TABLE job
  ADD COLUMN tokens_in        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN tokens_out       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN tool_call_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN llm_call_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN parent_job_id    UUID REFERENCES job(id) ON DELETE SET NULL,
  ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0;

-- 5. Add cost columns to session
ALTER TABLE session
  ADD COLUMN total_tokens_in  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_cost_usd   NUMERIC(12,6) NOT NULL DEFAULT 0;
