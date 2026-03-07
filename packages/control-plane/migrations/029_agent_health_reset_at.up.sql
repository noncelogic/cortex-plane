-- Add health_reset_at to the agent table.
-- When set, the circuit breaker hydration query ignores jobs completed
-- before this timestamp, breaking the quarantine death spiral (#443).
ALTER TABLE agent
  ADD COLUMN health_reset_at TIMESTAMPTZ;
