-- 020 down: Remove operator-visibility schema additions.

-- 1. Remove session cost columns
ALTER TABLE session
  DROP COLUMN IF EXISTS total_cost_usd,
  DROP COLUMN IF EXISTS total_tokens_out,
  DROP COLUMN IF EXISTS total_tokens_in;

-- 2. Remove job cost / delegation columns
ALTER TABLE job
  DROP COLUMN IF EXISTS delegation_depth,
  DROP COLUMN IF EXISTS parent_job_id,
  DROP COLUMN IF EXISTS llm_call_count,
  DROP COLUMN IF EXISTS tool_call_count,
  DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS tokens_out,
  DROP COLUMN IF EXISTS tokens_in;

-- 3. Drop agent_event table and indexes
DROP INDEX IF EXISTS idx_agent_event_agent_cost;
DROP INDEX IF EXISTS idx_agent_event_type_created;
DROP INDEX IF EXISTS idx_agent_event_job_created;
DROP INDEX IF EXISTS idx_agent_event_session_created;
DROP INDEX IF EXISTS idx_agent_event_agent_created;
DROP TABLE IF EXISTS agent_event;

-- 4. Drop agent_event_type enum
DROP TYPE IF EXISTS agent_event_type;
