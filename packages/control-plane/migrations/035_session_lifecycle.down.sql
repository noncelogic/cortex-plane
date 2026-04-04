-- 035: Remove session lifecycle timestamps and restore legacy close semantics.

DROP INDEX IF EXISTS idx_session_agent_user_status_activity;

UPDATE session
SET status = CASE
  WHEN status = 'closed' THEN 'ended'
  ELSE status
END;

ALTER TABLE session
  DROP COLUMN IF EXISTS last_activity_at,
  DROP COLUMN IF EXISTS last_resumed_at,
  DROP COLUMN IF EXISTS idle_at,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS closed_at;
