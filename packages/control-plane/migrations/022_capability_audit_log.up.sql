-- 022: Create capability_audit_log table.
--      Provides audit trail for tool invocation, denial, and rate-limiting.
--      Part of the agent capabilities epic (#264), Phase 1.

CREATE TABLE capability_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL,
  tool_ref         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  actor_user_id    UUID,
  job_id           UUID,
  details          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cal_agent ON capability_audit_log(agent_id, created_at DESC);
CREATE INDEX idx_cal_tool ON capability_audit_log(tool_ref, created_at DESC);
CREATE INDEX idx_cal_rate_limit ON capability_audit_log(agent_id, tool_ref, created_at)
  WHERE event_type = 'tool_invoked';
