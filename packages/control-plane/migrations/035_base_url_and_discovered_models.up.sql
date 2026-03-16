-- 035: Add base_url to provider_credential and create discovered_model table.
--      Supports custom provider endpoints (Antigravity proxies, OpenAI-compatible)
--      and persistent model discovery cache that survives restarts.
--      Part of issue #674.

-- 1. Add base_url column to provider_credential
ALTER TABLE provider_credential
  ADD COLUMN base_url TEXT;

-- 2. Create discovered_model table for persistent model cache
CREATE TABLE discovered_model (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id VARCHAR(255) NOT NULL,
  model_id    VARCHAR(255) NOT NULL,
  label       VARCHAR(512) NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider_id, model_id)
);

-- 3. Indexes
CREATE INDEX idx_discovered_model_provider ON discovered_model(provider_id);
