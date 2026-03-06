-- 019: Migrate mcp_server.agent_scope and agent.skill_config.allowedTools
--      into explicit agent_tool_binding rows.
--      Part of the agent-capabilities epic (#264, ticket T6).
--      Idempotent: uses ON CONFLICT DO NOTHING throughout.

-- Step 1: Expand mcp_server.agent_scope arrays into agent_tool_binding rows.
-- For each MCP server with a non-empty agent_scope, insert a binding for every
-- (agent_id, tool) combination using the tool's qualified_name as tool_ref.
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  scope.agent_id::uuid,
  t.qualified_name,
  'auto'::tool_approval_policy
FROM mcp_server s
CROSS JOIN LATERAL jsonb_array_elements_text(s.agent_scope) AS scope(agent_id)
JOIN mcp_server_tool t ON t.mcp_server_id = s.id
JOIN agent a ON a.id = scope.agent_id::uuid
WHERE jsonb_array_length(s.agent_scope) > 0
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- Step 2: Expand agent.skill_config.allowedTools into agent_tool_binding rows.
-- Handles both camelCase (allowedTools) and snake_case (allowed_tools) keys.
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  a.id,
  tool_name.value,
  'auto'::tool_approval_policy
FROM agent a
CROSS JOIN LATERAL jsonb_array_elements_text(
  COALESCE(
    a.skill_config -> 'allowedTools',
    a.skill_config -> 'allowed_tools',
    '[]'::jsonb
  )
) AS tool_name(value)
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- Step 3: Clear agent_scope on servers that had a non-empty scope.
UPDATE mcp_server
SET agent_scope = '[]'::jsonb
WHERE jsonb_array_length(agent_scope) > 0;
