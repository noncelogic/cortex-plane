-- 007: Job state transition trigger + updated_at trigger

-- Generic updated_at trigger function — reused across tables
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_updated_at
  BEFORE UPDATE ON agent
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_session_updated_at
  BEFORE UPDATE ON session
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_job_updated_at
  BEFORE UPDATE ON job
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Job state machine transition validation
CREATE OR REPLACE FUNCTION validate_job_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow updates that don't change status
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PENDING'              AND NEW.status IN ('SCHEDULED', 'FAILED')) OR
    (OLD.status = 'SCHEDULED'            AND NEW.status IN ('RUNNING', 'FAILED')) OR
    (OLD.status = 'RUNNING'              AND NEW.status IN ('COMPLETED', 'FAILED', 'TIMED_OUT', 'WAITING_FOR_APPROVAL')) OR
    (OLD.status = 'WAITING_FOR_APPROVAL' AND NEW.status IN ('RUNNING', 'FAILED', 'TIMED_OUT')) OR
    (OLD.status = 'FAILED'               AND NEW.status IN ('RETRYING', 'DEAD_LETTER')) OR
    (OLD.status = 'TIMED_OUT'            AND NEW.status IN ('RETRYING', 'DEAD_LETTER')) OR
    (OLD.status = 'RETRYING'             AND NEW.status IN ('SCHEDULED', 'DEAD_LETTER'))
  ) THEN
    RAISE EXCEPTION 'Invalid job transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_job_transition
  BEFORE UPDATE OF status ON job
  FOR EACH ROW
  EXECUTE FUNCTION validate_job_transition();
