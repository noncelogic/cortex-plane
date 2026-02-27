-- 012: Council subsystem tables

CREATE TYPE council_session_type AS ENUM (
  'STANDARD',
  'ADVISORY',
  'ESCALATION'
);

CREATE TYPE council_session_status AS ENUM (
  'OPEN',
  'DECIDED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE council_vote AS ENUM (
  'APPROVE',
  'REJECT',
  'ABSTAIN'
);

CREATE TABLE council_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         council_session_type NOT NULL,
  status       council_session_status NOT NULL DEFAULT 'OPEN',
  title        TEXT NOT NULL,
  context      JSONB NOT NULL DEFAULT '{}',
  participants JSONB NOT NULL DEFAULT '[]',
  decision     JSONB,
  decided_by   TEXT,
  decided_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  model_policy JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE council_votes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  voter      TEXT NOT NULL,
  vote       council_vote NOT NULL,
  confidence DOUBLE PRECISION,
  reasoning  TEXT,
  model_used TEXT,
  token_cost INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT council_votes_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  )
);

CREATE TABLE council_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_council_votes_session_voter ON council_votes (session_id, voter);
CREATE INDEX idx_council_votes_session ON council_votes (session_id);

CREATE INDEX idx_council_sessions_status ON council_sessions (status);
CREATE INDEX idx_council_sessions_type ON council_sessions (type);
CREATE INDEX idx_council_sessions_expires ON council_sessions (expires_at)
  WHERE status = 'OPEN';

CREATE INDEX idx_council_events_session ON council_events (session_id, created_at DESC);
CREATE INDEX idx_council_events_type ON council_events (event_type, created_at DESC);
