-- 032: content_item table for the Pulse content pipeline (#542)

CREATE TYPE content_status AS ENUM ('DRAFT', 'IN_REVIEW', 'QUEUED', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE content_type   AS ENUM ('blog', 'social', 'newsletter', 'report');

CREATE TABLE content_item (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID            NOT NULL REFERENCES agent(id),
  title           TEXT            NOT NULL,
  body            TEXT            NOT NULL DEFAULT '',
  type            content_type    NOT NULL DEFAULT 'blog',
  status          content_status  NOT NULL DEFAULT 'DRAFT',
  channel         TEXT,
  metadata        JSONB           NOT NULL DEFAULT '{}',
  published_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_item_agent_id ON content_item(agent_id);
CREATE INDEX idx_content_item_status   ON content_item(status);
CREATE INDEX idx_content_item_type     ON content_item(type);
