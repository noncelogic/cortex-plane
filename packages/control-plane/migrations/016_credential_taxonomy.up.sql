-- 016: Add credential_class enum and agent_credential_binding table.
--      Extends provider_credential with a taxonomy column so credentials
--      can represent LLM providers, MCP servers, individual tools, or
--      arbitrary custom secrets.  Adds a binding table that links agents
--      to specific credentials.
--      Part of the credential-taxonomy epic (#272).

-- 1. Create the credential_class enum type
CREATE TYPE credential_class AS ENUM (
  'llm_provider',
  'mcp_server',
  'tool_specific',
  'custom'
);

-- 2. Add new columns to provider_credential
ALTER TABLE provider_credential
  ADD COLUMN credential_class credential_class NOT NULL DEFAULT 'llm_provider',
  ADD COLUMN tool_name        VARCHAR(255),
  ADD COLUMN metadata         JSONB NOT NULL DEFAULT '{}';

-- 3. Backfill existing rows as llm_provider (DEFAULT already handles this,
--    but an explicit UPDATE makes intent clear for auditing).
UPDATE provider_credential
   SET credential_class = 'llm_provider'
 WHERE credential_class = 'llm_provider';  -- no-op, safe on empty or populated table

-- 4. Create agent_credential_binding table
CREATE TABLE agent_credential_binding (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  provider_credential_id UUID NOT NULL REFERENCES provider_credential(id) ON DELETE CASCADE,
  scope                  VARCHAR(255),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, provider_credential_id)
);

-- 5. Indexes
CREATE INDEX idx_provider_credential_class ON provider_credential(credential_class);
CREATE INDEX idx_provider_credential_tool  ON provider_credential(tool_name)
  WHERE tool_name IS NOT NULL;
CREATE INDEX idx_agent_credential_binding_agent ON agent_credential_binding(agent_id);
CREATE INDEX idx_agent_credential_binding_cred  ON agent_credential_binding(provider_credential_id);
