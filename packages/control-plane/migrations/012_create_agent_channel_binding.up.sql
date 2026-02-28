-- 012: Agent ↔ channel binding — maps chat channels to specific agents

CREATE TABLE agent_channel_binding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel_type, chat_id)
);

CREATE INDEX idx_agent_channel_binding_agent ON agent_channel_binding (agent_id);
CREATE INDEX idx_agent_channel_binding_default ON agent_channel_binding (channel_type, is_default)
  WHERE is_default = true;
