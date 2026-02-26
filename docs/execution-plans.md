# Execution Plans (Issue #135)

This feature adds versioned execution plan artifacts with durable checkpoint resume.

## Canonical plan schema

Canonical schema: `docs/schemas/execution-plan.schema.json` (`schema_version: v1`).

A plan version document includes:
- ordered `steps`
- `depends_on`
- `checkpoint_key`
- `rollback_hint`
- optional `approval_gate`

## Persistence model (PostgreSQL)

Migration: `010_execution_plans.*`

Tables:
- `execution_plan` (logical plan identity)
- `execution_plan_version` (immutable versioned artifact + source links to issue/PR/agent run/job/session)
- `execution_plan_run` (current run state)
- `execution_plan_event` (append-only timeline)

State machine: `PLANNED -> RUNNING -> BLOCKED -> COMPLETED|FAILED`.

DB trigger enforces valid transitions and append-only event history.

## Read-only timeline API

`GET /plans/runs/:runId/timeline`

Returns:
- plan metadata + version linkage (issue/pr/agent run/job/session)
- run state and approval gate status
- computed resume point (`checkpointKey`, `resumableStepId`, `requiresApproval`)
- immutable timeline events ordered by `occurredAt`

This endpoint is read-only and intended for human steering/observability.
