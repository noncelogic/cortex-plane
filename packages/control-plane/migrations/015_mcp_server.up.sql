-- 015: Add MCP server registry and tool catalog tables.
--      Part of the MCP integration epic (#262).

CREATE TYPE mcp_server_status AS ENUM (
  'PENDING',
  'ACTIVE',
  'DEGRADED',
  'ERROR',
  'DISABLED'
);

CREATE TYPE mcp_transport AS ENUM (
  'streamable-http',
  'stdio'
);

CREATE TABLE mcp_server (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(255) NOT NULL,
  slug                     VARCHAR(255) UNIQUE NOT NULL,
  transport                mcp_transport NOT NULL,
  connection               JSONB NOT NULL,
  agent_scope              JSONB NOT NULL DEFAULT '[]',
  description              TEXT,
  status                   mcp_server_status NOT NULL DEFAULT 'PENDING',
  protocol_version         VARCHAR(20),
  server_info              JSONB,
  capabilities             JSONB,
  health_probe_interval_ms INTEGER NOT NULL DEFAULT 30000,
  last_healthy_at          TIMESTAMPTZ,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mcp_server_tool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_server_id   UUID NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  qualified_name  VARCHAR(511) NOT NULL,
  description     TEXT,
  input_schema    JSONB NOT NULL,
  annotations     JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'available',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(mcp_server_id, name)
);

CREATE INDEX idx_mcp_server_tool_qualified ON mcp_server_tool(qualified_name);
CREATE INDEX idx_mcp_server_tool_name ON mcp_server_tool(name);
