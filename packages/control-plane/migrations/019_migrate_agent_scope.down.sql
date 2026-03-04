-- 019 down: Restore mcp_server.agent_scope from agent_tool_binding rows
--           and remove bindings that were created by migration 019.

-- 1. Restore agent_scope arrays on mcp_server from bindings that
--    reference tools belonging to each server.
UPDATE mcp_server s
SET agent_scope  = sub.agent_ids,
    updated_at   = now()
FROM (
  SELECT
    t.mcp_server_id,
    jsonb_agg(DISTINCT b.agent_id::text) AS agent_ids
  FROM agent_tool_binding b
  JOIN mcp_server_tool t ON t.qualified_name = b.tool_ref
  GROUP BY t.mcp_server_id
) sub
WHERE s.id = sub.mcp_server_id;

-- 2. Delete MCP-originated bindings (tool_ref matches an mcp_server_tool)
DELETE FROM agent_tool_binding b
USING mcp_server_tool t
WHERE b.tool_ref = t.qualified_name;

-- 3. Delete skill_config-originated bindings (tool_ref found in the
--    agent's skill_config.allowedTools array)
DELETE FROM agent_tool_binding b
WHERE EXISTS (
  SELECT 1
  FROM agent a
  WHERE a.id = b.agent_id
    AND a.skill_config ? 'allowedTools'
    AND jsonb_typeof(a.skill_config -> 'allowedTools') = 'array'
    AND b.tool_ref IN (
      SELECT jsonb_array_elements_text(a.skill_config -> 'allowedTools')
    )
);
