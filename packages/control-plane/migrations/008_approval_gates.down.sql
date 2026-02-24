-- 008 down: Remove approval gates additions

DROP TABLE IF EXISTS approval_audit_log;

ALTER TABLE approval_request DROP COLUMN IF EXISTS action_summary;
ALTER TABLE approval_request DROP COLUMN IF EXISTS notification_channels;
ALTER TABLE approval_request DROP COLUMN IF EXISTS approver_user_account_id;
ALTER TABLE approval_request DROP COLUMN IF EXISTS requested_by_agent_id;

ALTER TABLE job DROP COLUMN IF EXISTS approval_expires_at;
