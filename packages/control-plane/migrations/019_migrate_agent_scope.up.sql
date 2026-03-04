-- 019: Migrate mcp_server.agent_scope → agent_tool_binding rows.
--      Also migrates agent skill_config.allowedTools → agent_tool_binding.
--      Idempotent: ON CONFLICT DO NOTHING on all inserts.
--      Part of the agent capabilities epic (#264), Phase 2 (#306).

-- 1. Migrate mcp_server.agent_scope → agent_tool_binding
--    For each MCP server with a non-empty agent_scope array, create a
--    binding for every tool on that server for each agent in scope.
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  scope_agent.agent_id::uuid,
  t.qualified_name,
  'auto'::tool_approval_policy
FROM mcp_server s
CROSS JOIN LATERAL jsonb_array_elements_text(s.agent_scope) AS scope_agent(agent_id)
JOIN mcp_server_tool t ON t.mcp_server_id = s.id
WHERE jsonb_array_length(s.agent_scope) > 0
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- 2. Migrate agent skill_config.allowedTools → agent_tool_binding
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  a.id,
  tool_name.value,
  'auto'::tool_approval_policy
FROM agent a
CROSS JOIN LATERAL jsonb_array_elements_text(a.skill_config -> 'allowedTools') AS tool_name(value)
WHERE a.skill_config ? 'allowedTools'
  AND jsonb_typeof(a.skill_config -> 'allowedTools') = 'array'
  AND jsonb_array_length(a.skill_config -> 'allowedTools') > 0
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- 3. Clear migrated agent_scope arrays
UPDATE mcp_server
SET agent_scope  = '[]'::jsonb,
    updated_at   = now()
WHERE jsonb_array_length(agent_scope) > 0;
