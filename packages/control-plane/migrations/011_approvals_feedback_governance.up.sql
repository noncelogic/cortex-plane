-- 011: Approval risk-tier metadata + feedback governance tables

ALTER TABLE approval_request
  ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'P2',
  ADD COLUMN resume_payload JSONB,
  ADD COLUMN execution_result JSONB,
  ADD COLUMN resumed_at TIMESTAMPTZ,
  ADD COLUMN executed_at TIMESTAMPTZ,
  ADD COLUMN blast_radius TEXT;

ALTER TABLE approval_request
  ADD CONSTRAINT approval_request_risk_level_check
  CHECK (risk_level IN ('P0', 'P1', 'P2', 'P3'));

CREATE INDEX idx_approval_request_risk_level ON approval_request (risk_level, requested_at DESC);

CREATE TABLE feedback_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  task_id UUID,
  agent_id UUID REFERENCES agent(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('user_correction', 'automated', 'reflection')),
  category TEXT NOT NULL CHECK (category IN ('behavior', 'tone', 'accuracy', 'protocol')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  recurrence_key TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'in_progress', 'resolved')),
  remediation_status TEXT NOT NULL DEFAULT 'open' CHECK (remediation_status IN ('open', 'planned', 'applied', 'verified', 'failed')),
  remediation_notes TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_item_created ON feedback_item (created_at DESC);
CREATE INDEX idx_feedback_item_recurrence ON feedback_item (recurrence_key, created_at DESC)
  WHERE recurrence_key IS NOT NULL;

CREATE TABLE feedback_action (
  id BIGSERIAL PRIMARY KEY,
  feedback_id UUID NOT NULL REFERENCES feedback_item(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('prompt_patch', 'code_fix', 'config_change', 'rule_update')),
  action_ref TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'verified', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX idx_feedback_action_feedback_id ON feedback_action (feedback_id, created_at ASC);
