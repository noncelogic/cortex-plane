# Working Feature Velocity Loop

Purpose: keep Cortex Plane focused on shipping more working features faster without sacrificing runtime safety.

## Loop

1. **Pick smallest shippable slice** tied to one user-visible flow outcome.
2. **Implement with boundary clarity** (Data/API/UX ownership and affected flow).
3. **Verify on running stack** with integration evidence, not just unit confidence.
4. **Measure velocity signal** in PR evidence.
5. **Escalate friction**: if steering or rework exceeds one round, open stabilization issue.

## Required velocity signal for flow-touching PRs

Declare one lead-time outcome in PR evidence:

- `reduced` — this change measurably lowers lead time to a working feature.
- `unchanged` — no measurable lead-time movement.
- `increased` — accepted temporary slowdown; include reason and follow-up issue.

## Minimum proof set

For flow-touching PRs:

- Flow impacted and boundary touched.
- Convergence status from `docs/ops/openclaw-flow-parity-map.md`.
- Lead-time outcome (`reduced`/`unchanged`/`increased`).
- One concrete verification artifact from a running path (test output, smoke result, screenshot, trace, or logs).

## Stabilization trigger

Open a `stabilization` issue when any of the following occurs:

- Steering exceeds one round.
- Regression discovered on sibling surfaces after merge-ready implementation.
- Lead-time outcome is `increased` for two consecutive PRs on the same flow.
