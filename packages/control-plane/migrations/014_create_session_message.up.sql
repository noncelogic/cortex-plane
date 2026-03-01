-- 014: Add session_message table for multi-turn conversation history
--      and channel_id column on session for channel-scoped sessions.

-- Add channel_id to session for multi-channel session isolation
ALTER TABLE session ADD COLUMN channel_id TEXT;

-- Index to speed up session lookups scoped by channel
CREATE INDEX idx_session_agent_channel
  ON session (agent_id, channel_id)
  WHERE channel_id IS NOT NULL;

-- Conversation message log: each user/assistant turn is stored here.
CREATE TABLE session_message (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,        -- 'user' | 'assistant' | 'system' | 'tool'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata   JSONB DEFAULT '{}'
);

CREATE INDEX idx_session_message_session
  ON session_message (session_id, created_at);
