# First Deploy: Cortex Plane to k3s VM

Exact command sequence for deploying Cortex Plane from published images to a k3s single-node cluster. Assumes the VM is prepared per [k3s.md](./k3s.md).

---

## Prerequisites

| Requirement                                  | Verification                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| k3s running                                  | `kubectl get nodes` shows Ready                                                                          |
| kubectl configured                           | `kubectl cluster-info` succeeds                                                                          |
| GHCR access                                  | `docker pull ghcr.io/noncelogic/cortex-control-plane:8117302` succeeds (or image pull secret configured) |
| This repo cloned on the operator workstation | `ls deploy/k8s/overlays/prod/kustomization.yaml`                                                         |

---

## Step 1: Determine the release tag

Pick the SHA tag from the latest successful [Build & Publish Images](../../.github/workflows/docker-publish.yml) workflow run on `main`. The tag format is a 7-character git short SHA (e.g., `8117302`).

```bash
# List available tags (requires gh CLI or check GHCR UI):
gh api /orgs/noncelogic/packages/container/cortex-control-plane/versions \
  --jq '.[].metadata.container.tags[]' | head -10
```

---

## Step 2: Pin manifests to the release tag

```bash
cd deploy/k8s/overlays/prod

# Update image tags in kustomization.yaml
kustomize edit set image \
  ghcr.io/noncelogic/cortex-control-plane=ghcr.io/noncelogic/cortex-control-plane:<TAG> \
  ghcr.io/noncelogic/cortex-dashboard=ghcr.io/noncelogic/cortex-dashboard:<TAG>
```

Verify the tags were set:

```bash
grep 'newTag' kustomization.yaml
```

---

## Step 3: Create namespace and secrets

```bash
kubectl create namespace cortex

# Generate a credential master key
MASTER_KEY=$(openssl rand -hex 32)

# Create secrets
kubectl -n cortex create secret generic control-plane-secrets \
  --from-literal=DATABASE_URL='postgres://cortex:YOUR_PASSWORD@postgres:5432/cortex_plane' \
  --from-literal=CREDENTIAL_MASTER_KEY="${MASTER_KEY}"

kubectl -n cortex create secret generic postgres-secrets \
  --from-literal=POSTGRES_USER=cortex \
  --from-literal=POSTGRES_PASSWORD='YOUR_PASSWORD' \
  --from-literal=POSTGRES_DB=cortex_plane
```

If using GHCR private images, create an image pull secret:

```bash
kubectl -n cortex create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GH_USER \
  --docker-password=YOUR_GH_PAT

kubectl -n cortex patch serviceaccount default \
  -p '{"imagePullSecrets": [{"name": "ghcr-creds"}]}'
```

---

## Step 4: Deploy infrastructure (Postgres + Qdrant)

```bash
# From the repo root:
kubectl apply -k deploy/k8s/postgres/ -n cortex
kubectl apply -k deploy/k8s/qdrant/ -n cortex

# Wait for readiness
kubectl -n cortex rollout status deployment/postgres --timeout=120s
kubectl -n cortex rollout status deployment/qdrant --timeout=120s
```

---

## Step 5: Deploy application (control-plane + dashboard)

```bash
kubectl apply -k deploy/k8s/overlays/prod

# Wait for rollouts
kubectl -n cortex rollout status deployment/control-plane --timeout=120s
kubectl -n cortex rollout status deployment/dashboard --timeout=120s
```

---

## Step 6: Run database migrations

On first deploy, the database schema must be initialized:

```bash
kubectl -n cortex exec deploy/control-plane -- \
  node packages/control-plane/dist/migrate.js
```

Optionally seed demo data:

```bash
kubectl -n cortex exec deploy/control-plane -- \
  node packages/control-plane/dist/seed.js
```

---

## Step 7: Verify with smoke tests

```bash
./scripts/smoke-test-cluster.sh cortex
```

This runs through pod readiness, API health, dashboard reachability, DB connectivity, and image tag verification.

Manual verification:

```bash
# Port-forward for local access
kubectl -n cortex port-forward svc/control-plane 4000:4000 &
kubectl -n cortex port-forward svc/dashboard 3000:3000 &

curl -sf http://localhost:4000/healthz   # → 200
curl -sf http://localhost:4000/readyz    # → 200
curl -sf http://localhost:3000/          # → 200
```

---

## Step 8: Configure ingress (optional)

If the VM is network-accessible and you want external access:

```bash
kubectl apply -k deploy/k8s/overlays/prod
# The prod overlay includes ingress.yaml with Traefik annotations.
# Edit deploy/k8s/overlays/prod/ingress.yaml to set your hostname.
```

---

## Rollback

If anything goes wrong after deploy:

```bash
# Undo to previous revision
./scripts/rollback-cluster.sh --namespace cortex

# Or roll to a specific known-good tag
./scripts/rollback-cluster.sh --namespace cortex --tag <PREVIOUS_SHA>

# Verify after rollback
./scripts/smoke-test-cluster.sh cortex
```

Manual rollback:

```bash
kubectl -n cortex rollout undo deployment/control-plane
kubectl -n cortex rollout undo deployment/dashboard
kubectl -n cortex rollout status deployment/control-plane
kubectl -n cortex rollout status deployment/dashboard
```

---

## Troubleshooting

### Pods stuck in ImagePullBackOff

```bash
kubectl -n cortex describe pod -l app=control-plane | grep -A5 Events
```

Fix: Verify the image tag exists in GHCR and the pull secret is configured.

### control-plane CrashLoopBackOff

```bash
kubectl -n cortex logs deploy/control-plane --previous
```

Common causes: missing `control-plane-secrets`, unreachable Postgres, or unmigrated database.

### Dashboard shows 502 or connection errors

Verify `CORTEX_API_URL` in the dashboard ConfigMap points to the in-cluster control-plane service:

```bash
kubectl -n cortex get configmap dashboard-config -o yaml
```

Should show `CORTEX_API_URL: http://control-plane:4000`.

### PVC stuck in Pending

```bash
kubectl get storageclass
```

k3s must have the `local-path` storage class. If missing, the k3s installation may be incomplete.

---

## Checklist

- [ ] Release tag identified and images verified in GHCR
- [ ] Prod overlay pinned to immutable SHA tag
- [ ] Namespace and secrets created
- [ ] Postgres + Qdrant deployed and ready
- [ ] control-plane + dashboard deployed and ready
- [ ] Migrations run successfully
- [ ] Smoke tests pass
- [ ] Rollback tested once (undo + re-deploy)
- [ ] Ingress configured (if needed)
