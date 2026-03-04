-- 019 down: Drop agent_event table and indexes.

DROP INDEX IF EXISTS idx_agent_event_agent_model;
DROP INDEX IF EXISTS idx_agent_event_agent_created;
DROP TABLE IF EXISTS agent_event;
