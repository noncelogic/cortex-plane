# OAuth Feature Validation Runbook (Docker + Kubernetes Port-Forward)

> Non-priority follow-up validation runbook for issue #697.

This runbook gives a repeatable way to validate OAuth-connected behavior in local Docker and Kubernetes dev environments.

## Scope

- Feature area: OAuth provider connect/exchange + credential storage/health
- Services:
  - Control plane API (`:4000`)
  - Dashboard UI (`:3000`)
  - PostgreSQL + Qdrant dependencies
- Environments:
  - Docker Compose (local)
  - Kubernetes (`kubectl port-forward`)

---

## 1) Docker-based local validation path

### 1.1 Prerequisites

- Node.js 22+
- pnpm 10+
- Docker + Docker Compose plugin
- `.env` file (copy from `.env.example`)

```bash
cp .env.example .env
```

### 1.2 Required env vars

At minimum, set these in `.env`:

- `DATABASE_URL`
- `QDRANT_URL`
- `CREDENTIAL_MASTER_KEY` (required for encrypted credential storage)
- `DASHBOARD_URL` (example: `http://localhost:3000`)

For dashboard login providers (optional, but required if testing login redirects):

- `OAUTH_GITHUB_CLIENT_ID`
- `OAUTH_GITHUB_CLIENT_SECRET`
- `OAUTH_GOOGLE_CLIENT_ID`
- `OAUTH_GOOGLE_CLIENT_SECRET`

For LLM OAuth providers (only if testing env-driven provider enablement):

- `OAUTH_*_CLIENT_ID` and optional `OAUTH_*_CLIENT_SECRET` from `.env.example`

### 1.3 Start stack

Infra only:

```bash
pnpm docker:up
```

App + infra:

```bash
pnpm docker:up:full
```

### 1.4 Verify readiness before OAuth tests

```bash
docker compose ps
docker compose logs --no-color --tail=100 control-plane dashboard postgres qdrant
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:4000/readyz
curl -I http://127.0.0.1:3000/
```

Expected:

- `control-plane`, `dashboard`, `postgres`, `qdrant` are `healthy`/`running`
- `/healthz` returns 200
- `/readyz` returns 200 after DB/worker initialization
- dashboard root responds with HTTP 200/3xx

### 1.5 Execute OAuth-connected flow (known-good credentials)

1. Open dashboard settings page.
2. Start provider connect flow from Settings.
3. Complete provider auth in popup or code-paste flow.
4. Verify provider appears connected in settings.
5. Trigger credential health check in UI (if available).

Evidence to collect:

- Screenshot of connected provider state
- `control-plane` logs showing successful connect/exchange
- Optional API response snippets with sensitive values redacted

Common failure signatures:

- `invalid_client` / `unauthorized_client`: wrong client id/secret
- `redirect_uri_mismatch`: provider redirect URI does not match configured callback
- Missing encryption key: credential operations fail when `CREDENTIAL_MASTER_KEY` unset

### 1.6 Teardown

```bash
pnpm docker:down
```

---

## 2) Kubernetes port-forward validation path

### 2.1 Namespace/workload targets

Default namespace from manifests: `cortex`

Target services/workloads:

- `svc/control-plane` (port 4000)
- `svc/dashboard` (port 3000)
- optional dependency checks:
  - `svc/qdrant` (6333)
  - `svc/postgresql-rw-pooler` (5432)

### 2.2 Port-forward commands

```bash
kubectl -n cortex port-forward svc/control-plane 4000:4000
kubectl -n cortex port-forward svc/dashboard 3000:3000
```

Optional dependency checks:

```bash
kubectl -n cortex port-forward svc/qdrant 6333:6333
kubectl -n cortex port-forward svc/postgresql-rw-pooler 5432:5432
```

### 2.3 Verify forwarded endpoints are healthy

```bash
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:4000/readyz
curl -I http://127.0.0.1:3000/
curl -fsS http://127.0.0.1:6333/healthz
```

Cluster sanity checks:

```bash
kubectl -n cortex get pods
kubectl -n cortex get svc control-plane dashboard qdrant
kubectl -n cortex logs deploy/control-plane --tail=200
```

---

## 3) Connection secrets discovery + safe handling

### 3.1 Source of truth

- Local dev: `.env` (from `.env.example`)
- Kubernetes: `Secret/control-plane-secrets` in `cortex` namespace
  - template: `deploy/k8s/overlays/dev/secrets.example.yaml`

### 3.2 Required keys for this feature

Required for OAuth credential storage and flows:

- `CREDENTIAL_MASTER_KEY`
- provider credentials (`OAUTH_*` vars) for providers under test

Usually also required for app readiness during OAuth tests:

- `DATABASE_URL`
- `QDRANT_URL`

### 3.3 Safe load/injection patterns

Local:

- keep secrets in `.env` only
- do not commit `.env` or raw tokens

Kubernetes:

```bash
kubectl -n cortex create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://...' \
  --from-literal=CREDENTIAL_MASTER_KEY='...' \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 3.4 Redaction/security rules

- Never paste full access/refresh tokens in issues/PRs/logs
- Redact client secrets and API keys in screenshots
- Prefer short log snippets with sensitive values removed

---

## 4) Validation checklist (pass/fail)

Mark each item as ✅/❌ during execution:

- [ ] Docker path runs end-to-end (`pnpm docker:up:full` + health checks)
- [ ] Kubernetes port-forward path is executable and healthy
- [ ] Secret source-of-truth and required keys verified
- [ ] OAuth connect flow succeeds with known-good credentials
- [ ] Failure signatures checked (at least one negative-path observation)
- [ ] Validation evidence captured (logs/screens/output)

Minimum evidence to mark complete:

- one successful provider connect in Docker or K8s path
- healthy `/healthz` and `/readyz` checks
- sanitized log output proving token exchange success

---

## 5) Unit-test parity check (secondary / non-priority)

OpenClaw parity-style areas already covered in this repo include:

- `packages/control-plane/src/__tests__/oauth-providers.test.ts`
- `packages/control-plane/src/__tests__/oauth-session.test.ts`
- `packages/control-plane/src/__tests__/auth-connect-callback.test.ts`
- `packages/control-plane/src/__tests__/credential-service.test.ts`
- `packages/dashboard/src/__tests__/oauth-popup.test.ts`
- `packages/dashboard/src/__tests__/settings-providers.test.ts`

Gaps to consider (optional follow-up):

1. Add a focused integration-style test for settings connect flow + credential health endpoint round-trip.
2. Add a negative-path test asserting clear error messaging for `redirect_uri_mismatch` surfaced to UI.
3. Add docs-linked smoke test script for port-forward health endpoint checks.

These are secondary and should not preempt higher-priority pipeline work.
