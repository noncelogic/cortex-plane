-- 010: Durable memory extraction queue state (rollback)

DROP INDEX IF EXISTS idx_memory_extract_message_pending;
DROP TABLE IF EXISTS memory_extract_message;
DROP TABLE IF EXISTS memory_extract_session_state;

