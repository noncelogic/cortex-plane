-- 002: Create agent table — reusable autonomous agent definitions

CREATE TABLE agent (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL UNIQUE,
  slug                TEXT NOT NULL UNIQUE,
  role                TEXT NOT NULL,
  description         TEXT,
  model_config        JSONB NOT NULL DEFAULT '{}',
  skill_config        JSONB NOT NULL DEFAULT '{}',
  resource_limits     JSONB NOT NULL DEFAULT '{}',
  channel_permissions JSONB NOT NULL DEFAULT '{}',
  status              agent_status NOT NULL DEFAULT 'ACTIVE',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
