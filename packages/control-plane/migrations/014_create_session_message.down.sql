-- 014 down: Remove session_message table and channel_id column

DROP TABLE IF EXISTS session_message;
DROP INDEX IF EXISTS idx_session_agent_channel;
ALTER TABLE session DROP COLUMN IF EXISTS channel_id;
