-- 019: Create agent_event table for cost tracking and observability.
--      Stores per-call events (LLM calls, tool invocations) with cost_usd
--      so the control plane can aggregate cost-per-agent summaries.
--      Part of the Operator Visibility epic (#320), task #265-T12.

CREATE TABLE agent_event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  job_id          UUID REFERENCES job(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,          -- e.g. 'llm_call', 'tool_call'
  model           TEXT,                   -- model used (e.g. 'claude-sonnet-4-20250514')
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast per-agent cost aggregations filtered by date
CREATE INDEX idx_agent_event_agent_created
  ON agent_event (agent_id, created_at DESC);

-- Model-level cost breakdown
CREATE INDEX idx_agent_event_agent_model
  ON agent_event (agent_id, model)
  WHERE model IS NOT NULL;
