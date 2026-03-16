-- 035 down: Remove base_url from provider_credential and drop discovered_model table.
DROP TABLE IF EXISTS discovered_model;
ALTER TABLE provider_credential DROP COLUMN IF EXISTS base_url;
