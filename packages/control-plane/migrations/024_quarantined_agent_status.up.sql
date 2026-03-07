-- 024: Add QUARANTINED to agent_status enum (#310 / #314)
ALTER TYPE agent_status ADD VALUE IF NOT EXISTS 'QUARANTINED';
