-- 006: Create approval_request table for human-in-the-loop gates

CREATE TABLE approval_request (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,
  action_detail JSONB NOT NULL,
  token_hash    TEXT NOT NULL,
  status        approval_status NOT NULL DEFAULT 'PENDING',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    UUID REFERENCES user_account(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  decision_note TEXT
);

CREATE INDEX idx_approval_request_job ON approval_request (job_id);
CREATE INDEX idx_approval_request_status ON approval_request (status)
  WHERE status = 'PENDING';
CREATE INDEX idx_approval_request_token ON approval_request (token_hash)
  WHERE status = 'PENDING';
CREATE INDEX idx_approval_request_expires ON approval_request (expires_at)
  WHERE status = 'PENDING';
