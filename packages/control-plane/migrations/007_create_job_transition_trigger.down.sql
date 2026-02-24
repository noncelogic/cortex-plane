DROP TRIGGER IF EXISTS trg_validate_job_transition ON job;
DROP FUNCTION IF EXISTS validate_job_transition();

DROP TRIGGER IF EXISTS trg_job_updated_at ON job;
DROP TRIGGER IF EXISTS trg_session_updated_at ON session;
DROP TRIGGER IF EXISTS trg_agent_updated_at ON agent;
DROP FUNCTION IF EXISTS set_updated_at();
