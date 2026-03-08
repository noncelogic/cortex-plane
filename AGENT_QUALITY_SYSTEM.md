# Agent Quality System (AQS)

> Prevent recurring integration regressions and compound quality over time.

## Principles

1. **Every feature has a boundary contract.** Code changes touch Data, API, or UX boundaries — each must be explicitly identified and verified.
2. **Completion means evidence.** A ticket is not done until the PR is merged, evidence is attached, artifacts are updated, and a regression scan is performed.
3. **Bugs are pattern instances.** Each defect maps to a known bug class. If it doesn't, a new class is created and added to the pattern log.
4. **Sibling surfaces break together.** Changing one surface (e.g., an API route) requires checking sibling surfaces (e.g., the UI that calls it, the tests that cover it).
5. **Quality compounds.** Every PR updates the knowledge artifacts so future work benefits from past lessons.

## Boundary Model

All integration points fall into three boundary types:

| Boundary | Scope                                                                          | Examples                                                                   |
| -------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Data** | DB schema, FK relationships, enum values, migration ordering                   | credential_class enum, agent_credential_binding FKs, UUID formats          |
| **API**  | Route existence, request/response shape, status codes, Content-Type handling   | DELETE without body, dashboard endpoint registration, Zod schema alignment |
| **UX**   | Button wiring, form submissions, state display, error feedback, loading states | Settings page render, disconnect button handler, chat response display     |

### Boundary Drift

Drift occurs when two sides of a boundary change independently:

- **Data ↔ API**: migration adds a column but route handler doesn't expose it
- **API ↔ UX**: backend returns new shape but frontend Zod schema expects old shape
- **UX ↔ Data**: UI shows stale state because cache/polling doesn't reflect DB change

## Completion Gate

A ticket is **not complete** until all of the following are true:

- [ ] PR merged to main
- [ ] Evidence attached (test output, screenshot, or API response demonstrating the fix/feature)
- [ ] Knowledge artifacts updated (FEATURE_AUDIT.md, FLOW_MATRIX.md, PATTERN_LOG.md as applicable)
- [ ] Regression scan performed — sibling surfaces checked for breakage
- [ ] CI passes (lint, typecheck, test, build)

## PR Evidence Protocol

Every PR must include the AQS block in its description (enforced via PR template). The block covers:

1. **Flow impacted** — which critical user flow(s) this PR touches (reference FLOW_MATRIX.md)
2. **Boundaries touched** — Data / API / UX (one or more)
3. **Guarantees preserved or changed** — what invariants hold after this PR
4. **Evidence** — before/after proof (test output, screenshots, curl responses)
5. **Sibling-surface regression scan** — confirmation that related surfaces still work
6. **Knowledge artifact updates** — which AQS docs were updated and how

## Bug Classes

See [PATTERN_LOG.md](PATTERN_LOG.md) for the full catalog. The four primary classes are:

| Class                         | Description                                                          | Signal                                              |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| **Data boundary drift**       | FK mismatches, UUID format errors, enum inconsistencies              | 500 errors on write, constraint violations          |
| **UX boundary inconsistency** | Broken buttons, missing error feedback, silent drops                 | UI action with no visible result                    |
| **Auth/env boundary drift**   | Credential resolution failures, quarantine loops, config not applied | "No credential available", death spirals            |
| **Feature parity loss**       | Endpoints 404, buttons call nonexistent handlers, schema mismatches  | 404/501 responses, "Unexpected API response" toasts |

## File Index

| File                                                                 | Purpose                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| [AGENT_QUALITY_SYSTEM.md](AGENT_QUALITY_SYSTEM.md)                   | This file — principles, boundary model, completion gate |
| [FEATURE_AUDIT.md](FEATURE_AUDIT.md)                                 | Feature matrix: advertised vs actual working status     |
| [FLOW_MATRIX.md](FLOW_MATRIX.md)                                     | Critical user flows mapped to boundary guarantees       |
| [PATTERN_LOG.md](PATTERN_LOG.md)                                     | Bug classes, root causes, preventative controls         |
| [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) | PR template with AQS evidence block                     |
