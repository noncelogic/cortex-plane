-- 021 down: Restore mcp_server.agent_scope from agent_tool_binding rows.
--           Reverses the data migration performed by 021 up.
--           Idempotent: safe to run multiple times.

-- 1. Rebuild agent_scope arrays from MCP tool bindings.
--    For each server, collect distinct agent_ids that have bindings matching
--    that server's slug in the tool_ref pattern  mcp:<slug>:<name>.
UPDATE mcp_server s
SET agent_scope = sub.scope_array, updated_at = now()
FROM (
  SELECT
    split_part(atb.tool_ref, ':', 2) AS server_slug,
    jsonb_agg(DISTINCT atb.agent_id::text) AS scope_array
  FROM agent_tool_binding atb
  WHERE atb.tool_ref LIKE 'mcp:%:%'
  GROUP BY split_part(atb.tool_ref, ':', 2)
) sub
WHERE s.slug = sub.server_slug;

-- 2. Remove MCP tool bindings (the rows created from agent_scope expansion).
DELETE FROM agent_tool_binding
WHERE tool_ref LIKE 'mcp:%:%';

-- 3. Remove skill_config-derived bindings.
--    Match tool_ref against the agent's own allowed_tools / allowedTools list.
DELETE FROM agent_tool_binding atb
USING agent a
WHERE atb.agent_id = a.id
  AND atb.tool_ref NOT LIKE 'mcp:%'
  AND atb.tool_ref IN (
    SELECT jsonb_array_elements_text(
      COALESCE(a.skill_config->'allowedTools', a.skill_config->'allowed_tools')
    )
  );
