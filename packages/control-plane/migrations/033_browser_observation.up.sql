-- Browser observation persistence: screenshots + events
-- Closes #543

CREATE TYPE browser_event_type AS ENUM (
  'GET', 'CLICK', 'CONSOLE', 'SNAPSHOT', 'NAVIGATE', 'ERROR'
);

CREATE TYPE browser_event_severity AS ENUM ('info', 'warn', 'error');

CREATE TABLE browser_screenshot (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID              NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  thumbnail_url   TEXT              NOT NULL,
  full_url        TEXT              NOT NULL,
  width           INT               NOT NULL,
  height          INT               NOT NULL,
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX idx_browser_screenshot_agent ON browser_screenshot (agent_id, created_at DESC);

CREATE TABLE browser_event (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID                    NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  type            browser_event_type      NOT NULL,
  url             TEXT,
  selector        TEXT,
  message         TEXT,
  duration_ms     INT,
  severity        browser_event_severity  NOT NULL DEFAULT 'info',
  created_at      TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE INDEX idx_browser_event_agent ON browser_event (agent_id, created_at DESC);
