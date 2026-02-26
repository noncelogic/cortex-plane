-- 010: Versioned execution plan artifacts + immutable transition/event timeline

CREATE TYPE plan_run_state AS ENUM (
  'PLANNED',
  'RUNNING',
  'BLOCKED',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE execution_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE execution_plan_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES execution_plan(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  plan_document JSONB NOT NULL,
  source_issue_number INTEGER,
  source_pr_number INTEGER,
  source_agent_run_id UUID,
  source_job_id UUID REFERENCES job(id) ON DELETE SET NULL,
  source_session_id UUID REFERENCES session(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version_number)
);

CREATE TABLE execution_plan_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id UUID NOT NULL REFERENCES execution_plan_version(id) ON DELETE RESTRICT,
  state plan_run_state NOT NULL DEFAULT 'PLANNED',
  current_step_id TEXT,
  last_checkpoint_key TEXT,
  approval_gate_step_id TEXT,
  approval_gate_status approval_status,
  blocked_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE execution_plan_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_run_id UUID NOT NULL REFERENCES execution_plan_run(id) ON DELETE CASCADE,
  from_state plan_run_state,
  to_state plan_run_state,
  step_id TEXT,
  checkpoint_key TEXT,
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}',
  actor TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_execution_plan_version_plan ON execution_plan_version(plan_id, version_number DESC);
CREATE INDEX idx_execution_plan_run_version ON execution_plan_run(plan_version_id, created_at DESC);
CREATE INDEX idx_execution_plan_event_run_time ON execution_plan_event(plan_run_id, occurred_at ASC);

-- Ensure state transition legality
CREATE OR REPLACE FUNCTION validate_plan_run_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.state = 'PLANNED'   AND NEW.state IN ('RUNNING', 'BLOCKED', 'FAILED')) OR
    (OLD.state = 'RUNNING'   AND NEW.state IN ('BLOCKED', 'COMPLETED', 'FAILED')) OR
    (OLD.state = 'BLOCKED'   AND NEW.state IN ('RUNNING', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid plan run transition: % -> %', OLD.state, NEW.state;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_plan_run_transition
  BEFORE UPDATE OF state ON execution_plan_run
  FOR EACH ROW
  EXECUTE FUNCTION validate_plan_run_transition();

CREATE TRIGGER trg_execution_plan_updated_at
  BEFORE UPDATE ON execution_plan
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_execution_plan_run_updated_at
  BEFORE UPDATE ON execution_plan_run
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Append-only enforcement on event log
CREATE OR REPLACE FUNCTION prevent_plan_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'execution_plan_event is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_execution_plan_event_no_update
  BEFORE UPDATE ON execution_plan_event
  FOR EACH ROW
  EXECUTE FUNCTION prevent_plan_event_mutation();

CREATE TRIGGER trg_execution_plan_event_no_delete
  BEFORE DELETE ON execution_plan_event
  FOR EACH ROW
  EXECUTE FUNCTION prevent_plan_event_mutation();
