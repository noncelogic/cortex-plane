DROP TABLE IF EXISTS user_usage_ledger;
ALTER TABLE agent DROP COLUMN IF EXISTS auth_model;
DROP TYPE IF EXISTS agent_auth_model;
