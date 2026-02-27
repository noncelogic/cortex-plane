-- 010: Durable memory extraction queue state

CREATE TABLE memory_extract_session_state (
  session_id      UUID PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  pending_count   INTEGER NOT NULL DEFAULT 0,
  total_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_extract_message (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE RESTRICT,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  extracted_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_extract_role_check
    CHECK (role IN ('user', 'assistant', 'system'))
);

CREATE INDEX idx_memory_extract_message_pending
  ON memory_extract_message (session_id, extracted_at, id);

