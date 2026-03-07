-- 025: Operator visibility — enrich agent_event + add job/session cost columns.
--      Part of the operator visibility epic (#265-T1, #321).

-- 1. Create agent_event_type enum for reference / Kysely typing.
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

-- 2. Enrich agent_event table with columns from the operator visibility spec.
ALTER TABLE agent_event
  ADD COLUMN session_id      UUID REFERENCES session(id) ON DELETE SET NULL,
  ADD COLUMN parent_event_id UUID REFERENCES agent_event(id) ON DELETE SET NULL,
  ADD COLUMN tokens_in       INTEGER,
  ADD COLUMN tokens_out      INTEGER,
  ADD COLUMN duration_ms     INTEGER,
  ADD COLUMN model           TEXT,
  ADD COLUMN tool_ref        TEXT,
  ADD COLUMN actor           TEXT;

-- Rename details → payload (matches spec).
ALTER TABLE agent_event RENAME COLUMN details TO payload;

-- 3. Additional indexes required by the spec.
CREATE INDEX idx_ae_session    ON agent_event (session_id, created_at DESC);
CREATE INDEX idx_ae_job        ON agent_event (job_id, created_at DESC);
CREATE INDEX idx_ae_event_type ON agent_event (event_type, created_at DESC);
CREATE INDEX idx_ae_cost       ON agent_event (agent_id, cost_usd)
  WHERE cost_usd IS NOT NULL;

-- 4. Job cost + delegation columns (defaults preserve existing rows).
ALTER TABLE job
  ADD COLUMN tokens_in        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN tokens_out       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN cost_usd         NUMERIC(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN tool_call_count  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN llm_call_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN parent_job_id    UUID        REFERENCES job(id) ON DELETE SET NULL,
  ADD COLUMN delegation_depth INTEGER     NOT NULL DEFAULT 0;

-- 5. Session cost columns (defaults preserve existing rows).
ALTER TABLE session
  ADD COLUMN total_tokens_in  BIGINT         NOT NULL DEFAULT 0,
  ADD COLUMN total_tokens_out BIGINT         NOT NULL DEFAULT 0,
  ADD COLUMN total_cost_usd   NUMERIC(12, 6) NOT NULL DEFAULT 0;
