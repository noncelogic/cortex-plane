-- 023: Access request — approval queue for unknown users.
--      Part of the channel-authorization epic (#333).
--      Dependency for AccessRequestService (#337).

-- 1. Enum
CREATE TYPE access_request_status AS ENUM ('pending', 'approved', 'denied');

-- 2. access_request
CREATE TABLE access_request (
  id                 UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID                   NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  channel_mapping_id UUID                   NOT NULL REFERENCES channel_mapping(id) ON DELETE CASCADE,
  user_account_id    UUID                   NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  status             access_request_status  NOT NULL DEFAULT 'pending',
  message_preview    TEXT,
  reviewed_by        UUID                   REFERENCES user_account(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  deny_reason        TEXT,
  created_at         TIMESTAMPTZ            NOT NULL DEFAULT now(),
  UNIQUE (agent_id, user_account_id, status)
);

CREATE INDEX idx_ar_agent_pending
  ON access_request (agent_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX idx_ar_user ON access_request (user_account_id);
