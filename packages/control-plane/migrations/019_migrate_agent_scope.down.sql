-- 019 down: Revert agent_scope migration — restore mcp_server.agent_scope
--           arrays from agent_tool_binding rows and remove migrated bindings.

-- Step 1: Rebuild mcp_server.agent_scope from MCP tool bindings.
-- Collect distinct agent_ids that have bindings to each server's tools.
UPDATE mcp_server s
SET agent_scope = COALESCE(sub.scope, '[]'::jsonb)
FROM (
  SELECT
    t.mcp_server_id,
    jsonb_agg(DISTINCT atb.agent_id::text) AS scope
  FROM agent_tool_binding atb
  JOIN mcp_server_tool t ON atb.tool_ref = t.qualified_name
  GROUP BY t.mcp_server_id
) sub
WHERE sub.mcp_server_id = s.id;

-- Step 2: Remove bindings that were created from mcp_server.agent_scope
-- (tool_ref matches an mcp_server_tool qualified_name with auto approval).
DELETE FROM agent_tool_binding atb
USING mcp_server_tool t
WHERE atb.tool_ref = t.qualified_name
  AND atb.approval_policy = 'auto';

-- Step 3: Remove bindings that were created from skill_config.allowedTools.
DELETE FROM agent_tool_binding atb
WHERE atb.approval_policy = 'auto'
  AND EXISTS (
    SELECT 1 FROM agent a
    WHERE a.id = atb.agent_id
      AND (
        atb.tool_ref IN (
          SELECT jsonb_array_elements_text(a.skill_config -> 'allowedTools')
        )
        OR atb.tool_ref IN (
          SELECT jsonb_array_elements_text(a.skill_config -> 'allowed_tools')
        )
      )
  );
