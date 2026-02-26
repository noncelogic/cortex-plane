# Execution Checklist (WIP=1)

Use this checklist every cycle.

## A. Before starting a job
- [ ] Confirm no other coding job is running.
- [ ] Confirm selected ticket is READY.
- [ ] Confirm acceptance criteria are testable.
- [ ] Confirm dependencies/secrets are known.
- [ ] Record current objective in `docs/ops/NOW.md`.

## B. During job
- [ ] Track progress heartbeat (state change evidence).
- [ ] If blocked, send immediate blocker alert using standard format.
- [ ] If no progress for 30m, retry once or escalate blocked.

## C. On completion (`JOB_DONE`)
- [ ] Harvest result + verify claims.
- [ ] Run checks/tests/smoke relevant to change.
- [ ] Open PR or mark blocked with explicit evidence.
- [ ] Update ticket state/comments.
- [ ] Queue next READY ticket within 30m.

## D. Daily hygiene
- [ ] Keep two READY tickets in queue.
- [ ] Remove stale `status: in-progress` labels.
- [ ] Validate runbooks still match reality.
- [ ] Ensure periodic cron updates are summaries only (not first blocker signal).
