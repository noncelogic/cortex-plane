# Regression Catalog

Living document of known-good behaviors. Every bug fix adds a new entry.
Validated by the E2E suite (`e2e/tests/`) and cluster smoke tests (`scripts/smoke-test-cluster.sh`).

## How to use this catalog

1. **Before merging**: check that your PR does not break any behavior listed below.
2. **After fixing a bug**: add a row describing the expected behavior.
3. **E2E coverage**: link the E2E test file that covers the behavior (if any).

---

## Core user journeys

| #   | Journey          | Expected behavior                                                                 | E2E test                    |
| --- | ---------------- | --------------------------------------------------------------------------------- | --------------------------- |
| 1   | Health endpoints | `/healthz` returns 200; `/readyz` returns 200 with `db: ok, worker: ok`           | `health-smoke.spec.ts`      |
| 2   | Dashboard load   | Root page loads without uncaught JS errors or error banners                       | `dashboard-renders.spec.ts` |
| 3   | OAuth redirect   | Unauthenticated users are redirected to `/login`; auth providers list loads       | `oauth-redirect.spec.ts`    |
| 4   | Channel CRUD     | `GET /channels` returns list; invalid payloads return 400; unknown IDs return 404 | `channel-crud.spec.ts`      |
| 5   | Jobs panel       | `/jobs` page renders without JS errors; jobs API returns list or 401              | `jobs-panel.spec.ts`        |

## API contract guarantees

| Endpoint           | Method | Expected status            | Notes                                            |
| ------------------ | ------ | -------------------------- | ------------------------------------------------ |
| `/healthz`         | GET    | 200                        | Liveness probe — always returns if process is up |
| `/readyz`          | GET    | 200                        | Readiness probe — DB + worker must be connected  |
| `/health/backends` | GET    | 200 or 503                 | Circuit breaker state for execution backends     |
| `/health/mcp`      | GET    | 200 or 503                 | MCP server health aggregate                      |
| `/channels`        | GET    | 200 (auth) / 401 (no auth) | Returns masked channel configs                   |
| `/jobs`            | GET    | 200 (auth) / 401 (no auth) | Paginated job list                               |
| `/auth/providers`  | GET    | 200                        | Available OAuth providers                        |

## Regression entries

<!-- Add new entries below this line. Format:
| Date | Issue | Behavior | How verified |
-->

| Date       | Issue | Behavior                                                         | How verified                                        |
| ---------- | ----- | ---------------------------------------------------------------- | --------------------------------------------------- |
| 2026-03-08 | #453  | Deploy-gate blocks next ticket on smoke failure                  | `deploy-gate.yml` workflow                          |
| 2026-03-20 | #697  | OAuth validation runbook defines Docker + K8s port-forward paths | `docs/ops/oauth-feature-validation-runbook.md` walk |
