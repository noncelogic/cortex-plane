-- 009 down: Remove OAuth auth + credential management tables

DROP TABLE IF EXISTS credential_audit_log;
DROP TABLE IF EXISTS provider_credential;
DROP TABLE IF EXISTS dashboard_session;

ALTER TABLE user_account DROP COLUMN IF EXISTS email;
ALTER TABLE user_account DROP COLUMN IF EXISTS avatar_url;
ALTER TABLE user_account DROP COLUMN IF EXISTS role;
ALTER TABLE user_account DROP COLUMN IF EXISTS oauth_provider;
ALTER TABLE user_account DROP COLUMN IF EXISTS oauth_provider_id;
ALTER TABLE user_account DROP COLUMN IF EXISTS encryption_key_enc;
ALTER TABLE user_account DROP COLUMN IF EXISTS updated_at;

DROP INDEX IF EXISTS idx_user_oauth_identity;

DROP TYPE IF EXISTS user_role;
