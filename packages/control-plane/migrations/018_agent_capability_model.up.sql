-- 018: Add agent capability binding model — agent_tool_binding,
--      capability_audit_log, tool_category, tool_category_membership.
--      Extends agent table with effective_capabilities JSONB cache.
--      Deprecates mcp_server.agent_scope in favour of explicit bindings.
--      Part of the agent-capabilities epic (#264).

-- 1. Create tool_approval_policy enum
CREATE TYPE tool_approval_policy AS ENUM (
  'auto',
  'always_approve',
  'conditional'
);

-- 2. Create agent_tool_binding table
CREATE TABLE agent_tool_binding (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  tool_ref            TEXT NOT NULL,
  approval_policy     tool_approval_policy NOT NULL DEFAULT 'auto',
  approval_condition  JSONB,
  rate_limit          JSONB,
  cost_budget         JSONB,
  data_scope          JSONB,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, tool_ref)
);

CREATE INDEX idx_atb_agent ON agent_tool_binding(agent_id) WHERE enabled = true;

-- 3. Create capability_audit_log table
CREATE TABLE capability_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL,
  tool_ref        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  actor_user_id   UUID,
  job_id          UUID,
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cal_agent ON capability_audit_log(agent_id, created_at DESC);
CREATE INDEX idx_cal_tool  ON capability_audit_log(tool_ref, created_at DESC);

-- 4. Create tool_category and tool_category_membership tables
CREATE TABLE tool_category (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  icon        TEXT,
  description TEXT
);

CREATE TABLE tool_category_membership (
  tool_ref    TEXT NOT NULL,
  category_id UUID NOT NULL REFERENCES tool_category(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_ref, category_id)
);

-- 5. Add effective_capabilities JSONB column to agent
ALTER TABLE agent ADD COLUMN effective_capabilities JSONB;

-- 6. Add updated_at trigger for agent_tool_binding
CREATE TRIGGER trg_agent_tool_binding_updated_at
  BEFORE UPDATE ON agent_tool_binding
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- 7. Deprecate mcp_server.agent_scope
COMMENT ON COLUMN mcp_server.agent_scope IS 'DEPRECATED: use agent_tool_binding instead';
