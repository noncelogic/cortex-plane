-- 034 down: Re-add effective_capabilities JSONB column to agent table.
ALTER TABLE agent ADD COLUMN effective_capabilities JSONB;
