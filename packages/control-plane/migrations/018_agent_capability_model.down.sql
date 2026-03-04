-- 018 down: Revert agent capability model — drop tables, columns, and enum.

-- Remove deprecation comment on mcp_server.agent_scope
COMMENT ON COLUMN mcp_server.agent_scope IS NULL;

-- Drop trigger
DROP TRIGGER IF EXISTS trg_agent_tool_binding_updated_at ON agent_tool_binding;

-- Drop effective_capabilities column from agent
ALTER TABLE agent DROP COLUMN IF EXISTS effective_capabilities;

-- Drop tool_category_membership and tool_category
DROP TABLE IF EXISTS tool_category_membership;
DROP TABLE IF EXISTS tool_category;

-- Drop capability_audit_log indexes and table
DROP INDEX IF EXISTS idx_cal_tool;
DROP INDEX IF EXISTS idx_cal_agent;
DROP TABLE IF EXISTS capability_audit_log;

-- Drop agent_tool_binding index and table
DROP INDEX IF EXISTS idx_atb_agent;
DROP TABLE IF EXISTS agent_tool_binding;

-- Drop enum
DROP TYPE IF EXISTS tool_approval_policy;
