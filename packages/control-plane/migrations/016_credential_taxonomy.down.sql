-- 016 down: Revert credential taxonomy — drop binding table, columns, and enum.

DROP INDEX IF EXISTS idx_agent_credential_binding_cred;
DROP INDEX IF EXISTS idx_agent_credential_binding_agent;
DROP TABLE IF EXISTS agent_credential_binding;

DROP INDEX IF EXISTS idx_provider_credential_tool;
DROP INDEX IF EXISTS idx_provider_credential_class;

ALTER TABLE provider_credential
  DROP COLUMN IF EXISTS metadata,
  DROP COLUMN IF EXISTS tool_name,
  DROP COLUMN IF EXISTS credential_class;

DROP TYPE IF EXISTS credential_class;
