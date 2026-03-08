DROP TABLE IF EXISTS channel_allowlist_audit;
DROP TABLE IF EXISTS channel_allowlist;
ALTER TABLE channel_config DROP COLUMN IF EXISTS inbound_policy;
