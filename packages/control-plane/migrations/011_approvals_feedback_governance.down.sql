-- 011 down: drop feedback governance tables + approval metadata columns

DROP TABLE IF EXISTS feedback_action;
DROP TABLE IF EXISTS feedback_item;

DROP INDEX IF EXISTS idx_approval_request_risk_level;
ALTER TABLE approval_request DROP CONSTRAINT IF EXISTS approval_request_risk_level_check;

ALTER TABLE approval_request
  DROP COLUMN IF EXISTS blast_radius,
  DROP COLUMN IF EXISTS executed_at,
  DROP COLUMN IF EXISTS resumed_at,
  DROP COLUMN IF EXISTS execution_result,
  DROP COLUMN IF EXISTS resume_payload,
  DROP COLUMN IF EXISTS risk_level;
