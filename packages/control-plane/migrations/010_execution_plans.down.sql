DROP TRIGGER IF EXISTS trg_execution_plan_event_no_delete ON execution_plan_event;
DROP TRIGGER IF EXISTS trg_execution_plan_event_no_update ON execution_plan_event;
DROP FUNCTION IF EXISTS prevent_plan_event_mutation();

DROP TRIGGER IF EXISTS trg_execution_plan_run_updated_at ON execution_plan_run;
DROP TRIGGER IF EXISTS trg_execution_plan_updated_at ON execution_plan;

DROP TRIGGER IF EXISTS trg_validate_plan_run_transition ON execution_plan_run;
DROP FUNCTION IF EXISTS validate_plan_run_transition();

DROP TABLE IF EXISTS execution_plan_event;
DROP TABLE IF EXISTS execution_plan_run;
DROP TABLE IF EXISTS execution_plan_version;
DROP TABLE IF EXISTS execution_plan;

DROP TYPE IF EXISTS plan_run_state;
