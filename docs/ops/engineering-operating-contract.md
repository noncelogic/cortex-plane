# Engineering Operating Contract

Purpose: keep issue triage, implementation, and debugging aligned across humans and agents with minimal process overhead.

## 1) Product source of truth (how Cortex Plane works)

When behavior is unclear, use this precedence order:

1. **Running behavior + tests** (highest confidence)
   - Unit/integration tests under package test suites
   - E2E tests under `e2e/tests/`
2. **API/schema contracts**
   - OpenAPI: `docs/openapi.yaml`
   - Dashboard schemas + cross-boundary fixtures/tests
3. **Architecture and intent docs**
   - `README.md` (system overview + package map)
   - `docs/spec.md` (detailed architecture)
   - `docs/VISION.md` (design intent)

If these conflict, open a stabilization issue and reconcile code/tests/docs in the same PR when possible.

## 2) Issue intake contract (required quality for actionable tickets)

Use repository issue forms (`bug`, `feature`, `stabilization`).

A valid issue must include:

- Problem statement (or desired capability)
- Reproduction / acceptance criteria
- Architectural touch points (what layers are involved)
- Verification plan (how we will prove fix/feature)
- Documentation impact
- Breaking-change declaration

Issues missing these fields should be sent back for completion before implementation starts.

## 3) PR contract (what must pass before merge)

PRs must satisfy existing repository gates:

- PR template completed, including AQS section
- API/schema fixture alignment checks completed when relevant
- Unit + integration + regression evidence provided
- CI required check `ci` passes on `main`

Required local command bundle:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Cross-boundary changes must include/update contract tests (see `CONTRIBUTING.md`).

## 4) Deployment topology contract (where issues fail in prod-like paths)

Primary topology:

- **Control Plane** (`packages/control-plane`) — Fastify API + worker orchestration
- **Dashboard** (`packages/dashboard`) — operator UI
- **State services** — PostgreSQL + Qdrant
- **Adapters/backends** — channel adapters + model/execution backends

Deployment/release paths:

- CI quality gate: `.github/workflows/ci.yml`
- Image publish: `.github/workflows/docker-publish.yml`
- Deploy verification gate: `.github/workflows/deploy-gate.yml`
- K3s deployment runbook: `docs/deploy/k3s.md`
- Operational checks: `scripts/preflight-deploy.sh`, `scripts/smoke-test*.sh`

## 5) Debug-first triage flow for lead/ticketing

When a reported issue arrives:

1. Reproduce with exact environment + route/UI path
2. Classify boundary: **Data**, **API**, **UX**, or cross-boundary
3. Map to owner package(s) and impacted flow (reference `FLOW_MATRIX.md`)
4. Verify contract breakage with tests/fixtures/log evidence
5. Ticket as:
   - `bug` for behavior regressions
   - `feature` for net-new capability
   - `stabilization` for process/quality/systemic gaps

Every fix should leave a durable trace:

- test coverage update,
- docs/runbook update where needed,
- AQS artifact update when flow/pattern/boundary changed.

## 6) OpenClaw flow convergence + velocity contract

For PRs that touch runtime/chat/orchestration flows:

- Declare convergence status using `docs/ops/openclaw-flow-parity-map.md` (`parity`, `gap-reduction`, or `intentional-divergence`).
- Declare lead-time outcome using `docs/ops/working-feature-velocity-loop.md` (`reduced`, `unchanged`, or `increased`).
- Include at least one running-path verification artifact in PR evidence.
- If steering exceeds one round, link a `stabilization` issue.

## 7) Non-goals (to prevent process bloat)

- No agent-only governance forks
- No duplicate framework docs that restate existing checks
- No merge based on prose compliance alone; rely on enforceable checks
- No multi-round steering as default mode

This contract is intentionally concise and human-first. Agents must follow the same controls humans do.
