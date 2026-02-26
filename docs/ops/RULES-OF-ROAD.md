# Cortex Plane — Rules of the Road

**Purpose:** Keep delivery reliable under WIP=1 by enforcing explicit execution policy.

## 1) Primary Objective
- Demo deployment running and testable is priority #1 until declared complete.
- Status/labels/comments are not progress; only validated outcomes are progress.

## 2) WIP Policy
- Implementation WIP is hard-limited to **1 active coding job**.
- While 1 coding job is running, non-coding prep/triage/docs may continue.

## 3) Ticket Readiness Gate (Definition of Ready)
A ticket is READY only if it has:
- clear scope
- testable acceptance criteria
- dependency list
- required env/secrets explicitly listed
- deploy/rollback expectations (if deploy-impacting)

If any item is missing, ticket is not READY.

## 4) Handoff SLA
On `JOB_DONE:<id>`:
- T+0–10m: harvest result, run verification
- T+10–25m: open PR **or** declare blocker
- T+25–30m: queue next READY ticket

## 5) Blocker Escalation (Immediate)
Do not wait for periodic cron updates.

Blocker message format:
- `BLOCKED: <ticket>`
- `WHY: <single root cause>`
- `NEEDED FROM JOE: <exact command/value/approval>`
- `FALLBACK IN PROGRESS: <what is still moving>`

## 6) Stall Detection
A task is stalled when there is no state change for 30 minutes.
- Retry once if safe.
- If still stalled, flag blocked immediately.

## 7) Queue Selection
- Skip: `blocked`, `needs-design`, `needs-joe`, non-executable epic umbrellas
- Pick highest priority READY ticket
- Keep at least two tickets prepped ahead of active work

## 8) Source of Truth
Operational policy is defined by files in `docs/ops/` and executable checks in `scripts/`.
Memory systems are context aids, not policy authority.
