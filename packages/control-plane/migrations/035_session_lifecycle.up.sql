-- 035: Add first-class session lifecycle timestamps and normalize close semantics.

ALTER TABLE session
  ADD COLUMN last_activity_at TIMESTAMPTZ,
  ADD COLUMN last_resumed_at TIMESTAMPTZ,
  ADD COLUMN idle_at TIMESTAMPTZ,
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN closed_at TIMESTAMPTZ;

UPDATE session
SET
  status = CASE
    WHEN lower(status) IN ('ended', 'terminated', 'closed') THEN 'closed'
    WHEN lower(status) IN ('paused', 'idle') THEN 'idle'
    WHEN lower(status) = 'archived' THEN 'archived'
    ELSE 'active'
  END,
  last_activity_at = COALESCE(updated_at, created_at),
  last_resumed_at = CASE
    WHEN lower(status) IN ('ended', 'terminated', 'closed') THEN NULL
    ELSE COALESCE(updated_at, created_at)
  END,
  idle_at = CASE
    WHEN lower(status) IN ('paused', 'idle') THEN COALESCE(updated_at, created_at)
    ELSE NULL
  END,
  archived_at = CASE
    WHEN lower(status) = 'archived' THEN COALESCE(updated_at, created_at)
    ELSE NULL
  END,
  closed_at = CASE
    WHEN lower(status) IN ('ended', 'terminated', 'closed') THEN COALESCE(updated_at, created_at)
    ELSE NULL
  END;

ALTER TABLE session
  ALTER COLUMN last_activity_at SET NOT NULL,
  ALTER COLUMN last_activity_at SET DEFAULT now();

CREATE INDEX idx_session_agent_user_status_activity
  ON session (agent_id, user_account_id, status, last_activity_at DESC);

