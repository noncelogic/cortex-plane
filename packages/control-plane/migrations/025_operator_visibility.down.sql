-- 025 down: Revert operator visibility schema changes.

-- 5. Drop session cost columns.
ALTER TABLE session
  DROP COLUMN IF EXISTS total_tokens_in,
  DROP COLUMN IF EXISTS total_tokens_out,
  DROP COLUMN IF EXISTS total_cost_usd;

-- 4. Drop job cost + delegation columns.
ALTER TABLE job
  DROP COLUMN IF EXISTS tokens_in,
  DROP COLUMN IF EXISTS tokens_out,
  DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS tool_call_count,
  DROP COLUMN IF EXISTS llm_call_count,
  DROP COLUMN IF EXISTS parent_job_id,
  DROP COLUMN IF EXISTS delegation_depth;

-- 3. Drop additional indexes.
DROP INDEX IF EXISTS idx_ae_session;
DROP INDEX IF EXISTS idx_ae_job;
DROP INDEX IF EXISTS idx_ae_event_type;
DROP INDEX IF EXISTS idx_ae_cost;

-- 2. Rename payload back to details.
ALTER TABLE agent_event RENAME COLUMN payload TO details;

-- 2. Drop new agent_event columns.
ALTER TABLE agent_event
  DROP COLUMN IF EXISTS session_id,
  DROP COLUMN IF EXISTS parent_event_id,
  DROP COLUMN IF EXISTS tokens_in,
  DROP COLUMN IF EXISTS tokens_out,
  DROP COLUMN IF EXISTS duration_ms,
  DROP COLUMN IF EXISTS model,
  DROP COLUMN IF EXISTS tool_ref,
  DROP COLUMN IF EXISTS actor;

-- 1. Drop enum type.
DROP TYPE IF EXISTS agent_event_type;
