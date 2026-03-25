# Ownership + Autonomy Matrix

Purpose: make default ownership explicit so features can ship with minimal steering.

## Default owner mapping

| Work type                                                                | Default owner                             | Steering required before implementation? | Escalate when                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| OpenClaw-transition roadmap and sequence planning                        | **Project Orchestrator**                  | No                                       | Timeline/risk crosses external dependency boundaries          |
| Extensibility direction changes (CLI tools -> MCP/internal browser tool) | **Project Orchestrator**                  | No                                       | API contract break or migration risk across multiple packages |
| Agent session-management architecture and state model                    | **Project Orchestrator**                  | No                                       | Data-model changes require cross-team migration coordination  |
| Steering/visibility control surfaces and orchestration policy            | **Project Orchestrator**                  | No                                       | Runtime safety or production blast-radius concern             |
| Package-local implementation fixes with unchanged contracts              | Package owner/implementer                 | No                                       | Scope expands into cross-boundary contract changes            |
| Cross-boundary API + UX + data contract changes                          | Joint (Orchestrator + implementing owner) | Yes (single alignment decision)          | Acceptance criteria conflict or unclear product intent        |

## Autonomy rule-set

1. If an issue maps to a single default owner row above, implementation starts without extra approval.
2. One alignment decision is the max normal steering budget for cross-boundary work.
3. If steering exceeds one round, open a `stabilization` issue documenting the ambiguity and proposed contract fix.

## Evidence expectation in PRs

PRs touching orchestrator-owned rows must include:

- owner declaration,
- steering rounds used (`0`, `1`, or `>1`),
- note for any `>1` steering event with contract/process fix.
