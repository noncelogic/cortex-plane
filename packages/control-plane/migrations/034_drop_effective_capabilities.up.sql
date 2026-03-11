-- 034: Drop unused effective_capabilities JSONB column from agent table.
-- Added in 018 as a computed-cache column but never read or written
-- by application code. Closes #557.
ALTER TABLE agent DROP COLUMN IF EXISTS effective_capabilities;
