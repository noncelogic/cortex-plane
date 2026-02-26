# Demo Day Runbook

Operational guide for running Cortex Plane during a live demo. Follow this sequentially.

---

## 1. Pre-Demo Checklist

Run at least 30 minutes before demo time.

### Run preflight checks

```bash
./scripts/preflight-deploy.sh
```

This verifies: environment file, required variables (`DATABASE_URL`), Docker availability, local image presence, and toolchain.

### Verify image versions

For Docker Compose:

```bash
docker compose images
```

For Kubernetes:

```bash
kubectl -n cortex-plane get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'
```

### Confirm services are not already running in a broken state

```bash
# Docker Compose
docker compose ps

# Kubernetes
kubectl -n cortex-plane get pods
```

If anything is in a crash loop or unhealthy state, fix it before proceeding (see Section 4).

---

## 2. Start Sequence

### Option A: Docker Compose (local/VM demo)

Full stack (Postgres + Qdrant + control-plane + dashboard):

```bash
docker compose --profile full up -d --build
```

Wait for health checks to pass:

```bash
docker compose ps
# All services should show "healthy" status
```

### Option B: Kubernetes (k3s / remote cluster)

```bash
kubectl apply -k deploy/k8s/qdrant/ -n cortex-plane
kubectl apply -k deploy/k8s/control-plane/ -n cortex-plane
kubectl apply -k deploy/k8s/dashboard/ -n cortex-plane
```

Wait for rollouts:

```bash
kubectl -n cortex-plane rollout status deployment/qdrant
kubectl -n cortex-plane rollout status deployment/control-plane
kubectl -n cortex-plane rollout status deployment/dashboard
```

---

## 3. Verify

Run the smoke test:

```bash
./scripts/smoke-test.sh http://localhost:4000
```

Expected output: all checks pass for `/healthz`, `/readyz`, Qdrant `/healthz`, and dashboard `/`.

Manual spot check:

```bash
curl -sf http://localhost:4000/healthz        # 200
curl -sf http://localhost:4000/readyz         # 200
curl -sf http://localhost:4000/health/backends # 200 (shows Postgres + Qdrant status)
curl -sf http://localhost:3000/               # 200
```

Open the dashboard in a browser at `http://localhost:3000` and confirm the page loads.

---

## 4. Common Failure Modes and Recovery

### control-plane won't start

**Symptom:** CrashLoopBackOff or container exits immediately.

```bash
# Docker Compose
docker compose logs control-plane --tail 50

# Kubernetes
kubectl -n cortex-plane logs deploy/control-plane --previous
```

**Likely causes and fixes:**
- `DATABASE_URL` missing or wrong: check `.env` or the `control-plane-secrets` Secret.
- Postgres not ready: wait for Postgres to be healthy, then restart control-plane.
- Migration not run: `pnpm db:migrate` (compose) or `kubectl exec` (k8s).

### dashboard shows blank page or API errors

**Symptom:** Page loads but shows connection errors or empty state.

**Fix:** Verify `CORTEX_API_URL` points to a reachable control-plane URL. For Docker Compose this should be `http://control-plane:4000`. Check browser console for `NEXT_PUBLIC_CORTEX_API_URL` errors.

### Qdrant not reachable

**Symptom:** `/health/backends` shows Qdrant as down.

```bash
curl -sf http://localhost:6333/healthz
```

If unreachable, restart Qdrant:

```bash
# Docker Compose
docker compose restart qdrant

# Kubernetes
kubectl -n cortex-plane rollout restart deployment/qdrant
```

### Postgres connection refused

**Symptom:** `/readyz` fails, logs show `ECONNREFUSED`.

```bash
# Docker Compose
docker compose logs postgres --tail 20
docker compose restart postgres

# Kubernetes
kubectl -n cortex-plane logs deploy/postgres --tail 20
```

---

## 5. Single-Service Restart Procedure

### Docker Compose

```bash
# Restart one service without touching others
docker compose restart <service-name>

# Example:
docker compose restart control-plane

# If the image needs rebuilding:
docker compose up -d --build control-plane
```

### Kubernetes

```bash
kubectl -n cortex-plane rollout restart deployment/<name>
kubectl -n cortex-plane rollout status deployment/<name>
```

Service names: `control-plane`, `dashboard`, `qdrant`, `postgres` (if in-cluster).

---

## 6. Full-Stack Rollback Procedure

### Docker Compose

If the current state is broken and you need to start fresh:

```bash
# Tear down everything (preserves volumes)
docker compose --profile full down

# Bring back up
docker compose --profile full up -d --build
```

To also reset data (destructive):

```bash
docker compose --profile full down -v
docker compose --profile full up -d --build
pnpm db:migrate
pnpm db:seed  # if seed data is needed for demo
```

### Kubernetes

Roll back to the previous deployment revision:

```bash
kubectl -n cortex-plane rollout undo deployment/control-plane
kubectl -n cortex-plane rollout undo deployment/dashboard
```

Verify:

```bash
kubectl -n cortex-plane rollout status deployment/control-plane
kubectl -n cortex-plane rollout status deployment/dashboard
```

Nuclear option -- delete and reapply all manifests:

```bash
kubectl delete -k deploy/k8s/dashboard/ -n cortex-plane
kubectl delete -k deploy/k8s/control-plane/ -n cortex-plane
# DO NOT delete qdrant or postgres unless you want to lose data
kubectl apply -k deploy/k8s/control-plane/ -n cortex-plane
kubectl apply -k deploy/k8s/dashboard/ -n cortex-plane
```

---

## 7. Emergency Contacts / Escalation

| Role | Contact | When to Escalate |
|------|---------|-----------------|
| Project lead | (fill in) | Any issue not resolved within 5 minutes |
| Infra / DevOps | (fill in) | VM unreachable, k3s cluster down, networking issues |
| Backend engineer | (fill in) | control-plane crash loops, migration failures, data issues |
| Frontend engineer | (fill in) | Dashboard rendering errors, API integration failures |

**Escalation timeline during demo:**
- 0-2 min: Try single-service restart (Section 5).
- 2-5 min: Try full-stack rollback (Section 6).
- 5+ min: Escalate to the relevant contact. Consider switching to a backup environment or recorded demo.

---

## 8. Post-Demo Teardown

### Docker Compose

```bash
# Stop all services, keep data for next time
docker compose --profile full down

# Stop and remove data volumes (full cleanup)
docker compose --profile full down -v
```

### Kubernetes

Leave running if the cluster is persistent. If tearing down:

```bash
kubectl delete namespace cortex-plane
```

### Cleanup checklist

- [ ] Stop port-forwards if any are running
- [ ] Revoke any temporary credentials or API keys used for demo
- [ ] Note any issues encountered for post-mortem
- [ ] Save demo data/screenshots if needed before teardown
