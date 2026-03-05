-- 021: Migrate mcp_server.agent_scope → agent_tool_binding rows.
--      Also migrates agent skill_config.allowedTools / allowed_tools entries.
--      Part of the agent capabilities epic (#264), Phase 2.
--      References: GitHub issue #306.
--
--      Idempotent: uses ON CONFLICT (agent_id, tool_ref) DO NOTHING.

-- 1. For each mcp_server with a non-empty agent_scope array, expand every
--    (agent_id, tool) pair into an agent_tool_binding row.
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  scope_agent.agent_id::uuid,
  'mcp:' || s.slug || ':' || t.name,
  'auto'
FROM mcp_server s
CROSS JOIN LATERAL jsonb_array_elements_text(s.agent_scope) AS scope_agent(agent_id)
JOIN mcp_server_tool t ON t.mcp_server_id = s.id
-- Only include agent_ids that still exist (FK safety)
JOIN agent a ON a.id = scope_agent.agent_id::uuid
WHERE jsonb_array_length(s.agent_scope) > 0
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- 2. For each agent with skill_config allowedTools / allowed_tools,
--    insert a binding per tool name.
INSERT INTO agent_tool_binding (agent_id, tool_ref, approval_policy)
SELECT
  a.id,
  tool.value,
  'auto'
FROM agent a
CROSS JOIN LATERAL jsonb_array_elements_text(
  COALESCE(a.skill_config->'allowedTools', a.skill_config->'allowed_tools')
) AS tool(value)
WHERE COALESCE(
        a.skill_config->'allowedTools',
        a.skill_config->'allowed_tools'
      ) IS NOT NULL
  AND jsonb_typeof(
        COALESCE(a.skill_config->'allowedTools', a.skill_config->'allowed_tools')
      ) = 'array'
  AND jsonb_array_length(
        COALESCE(a.skill_config->'allowedTools', a.skill_config->'allowed_tools')
      ) > 0
ON CONFLICT (agent_id, tool_ref) DO NOTHING;

-- 3. Clear non-empty agent_scope arrays after successful migration.
UPDATE mcp_server
SET agent_scope = '[]'::jsonb, updated_at = now()
WHERE agent_scope != '[]'::jsonb;
