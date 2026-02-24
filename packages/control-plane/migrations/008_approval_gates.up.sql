-- 008: Approval gates — extend job table, add audit log
-- Builds on 005 (job) and 006 (approval_request) to support
-- human-in-the-loop approval gates with full audit trail.

-- Add approval_expires_at to job table
ALTER TABLE job ADD COLUMN approval_expires_at TIMESTAMPTZ;

-- Add requested_by_agent_id to approval_request (which agent triggered the gate)
ALTER TABLE approval_request ADD COLUMN requested_by_agent_id UUID REFERENCES agent(id) ON DELETE RESTRICT;

-- Add approver_user_account_id (designated approver, NULL = any authorized user)
ALTER TABLE approval_request ADD COLUMN approver_user_account_id UUID REFERENCES user_account(id) ON DELETE SET NULL;

-- Add notification_channels tracking (which channels were notified)
ALTER TABLE approval_request ADD COLUMN notification_channels JSONB NOT NULL DEFAULT '[]';

-- Add action_summary as human-readable one-liner (existing action_type + action_detail stay)
ALTER TABLE approval_request ADD COLUMN action_summary TEXT;

-- Approval audit log — captures events beyond the approval_request lifecycle
CREATE TABLE approval_audit_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id   UUID REFERENCES approval_request(id) ON DELETE SET NULL,
  job_id                UUID REFERENCES job(id) ON DELETE SET NULL,
  event_type            TEXT NOT NULL,
  actor_user_id         UUID REFERENCES user_account(id) ON DELETE SET NULL,
  actor_channel         TEXT,
  details               JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for approval_audit_log
CREATE INDEX idx_audit_log_request ON approval_audit_log (approval_request_id, created_at DESC);
CREATE INDEX idx_audit_log_job ON approval_audit_log (job_id, created_at DESC);
CREATE INDEX idx_audit_log_event_type ON approval_audit_log (event_type, created_at DESC);
