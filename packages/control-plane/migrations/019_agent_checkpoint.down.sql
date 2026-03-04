-- 019 down: Drop agent_checkpoint table and index.

DROP INDEX IF EXISTS idx_acp_agent;
DROP TABLE IF EXISTS agent_checkpoint;
