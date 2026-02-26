# First Deploy: Cortex Plane to k3s VM

Exact command sequence for deploying Cortex Plane from published images to a k3s single-node cluster. Assumes the VM is prepared per [k3s.md](./k3s.md).

---

## Prerequisites

| Requirement                                  | Verification                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| k3s running                                  | `kubectl get nodes` shows Ready                                                                          |
| kubectl configured                           | `kubectl cluster-info` succeeds                                                                          |
| GHCR access (or local Docker)                | `docker pull ghcr.io/noncelogic/cortex-control-plane:<TAG>` succeeds, or Docker installed on the VM for local builds |
| This repo cloned on the operator workstation | `ls deploy/k8s/overlays/prod/kustomization.yaml`                                                         |

---

## Step 1: Determine the release tag

Pick the SHA tag from the latest successful [Build & Publish Images](../../.github/workflows/docker-publish.yml) workflow run on `main`. The tag format is a 7-character git short SHA (e.g., `afdf552`).

```bash
# List available tags (requires gh CLI or check GHCR UI):
gh api /orgs/noncelogic/packages/container/cortex-control-plane/versions \
  --jq '.[].metadata.container.tags[]' | head -10
```

### Alternative: Local build on the k3s VM

If GHCR packages are private and no `read:packages` PAT is available, build and import images locally:

```bash
# On the k3s VM — install Docker if not present
sudo apt-get install -y docker.io && sudo usermod -aG docker $USER

# Clone the repo and build
git clone https://github.com/noncelogic/cortex-plane.git && cd cortex-plane
TAG=$(git rev-parse --short HEAD)

docker build -f deploy/docker/Dockerfile.control-plane -t ghcr.io/noncelogic/cortex-control-plane:$TAG .
docker build -f deploy/docker/Dockerfile.dashboard -t ghcr.io/noncelogic/cortex-dashboard:$TAG .

# Import into k3s containerd
sudo docker save ghcr.io/noncelogic/cortex-control-plane:$TAG | sudo k3s ctr images import -
sudo docker save ghcr.io/noncelogic/cortex-dashboard:$TAG | sudo k3s ctr images import -

# Verify
sudo k3s crictl images | grep cortex
```

When using locally-imported images, set `imagePullPolicy: IfNotPresent` in the deployments (already the default in base manifests).

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

## Step 6: Database migrations

Migrations run automatically on startup via the control-plane's `auto-migrate.js` script. No manual migration step is needed for first deploy.

Verify migrations ran successfully by checking the `/readyz` endpoint:

```bash
kubectl -n cortex port-forward svc/control-plane 4000:4000 &
curl -s http://localhost:4000/readyz
# Expected: {"status":"ok","checks":{"worker":true,"db":true}}
```

If you need to run migrations manually (e.g., after a schema change without restarting):

```bash
kubectl -n cortex exec deploy/control-plane -- \
  node packages/control-plane/dist/migrate.js
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

## Step 8: Configure access

### Option A: Tailscale (recommended for demo)

Expose services over your Tailscale network — internal-only, no public endpoints.

```bash
# Create Tailscale auth secret (get key from https://login.tailscale.com/admin/settings/keys)
kubectl -n cortex create secret generic tailscale-auth \
  --from-literal=TS_AUTHKEY='tskey-auth-XXXXX'

# Deploy the Tailscale proxy
kubectl apply -k deploy/k8s/tailscale-proxy/ -n cortex
kubectl -n cortex rollout status deployment/tailscale-proxy --timeout=60s

# Verify
./scripts/tailscale-verify.sh cortex cortex-demo
```

Access at `https://cortex-demo.<tailnet>.ts.net/` from any device on your tailnet. Full setup: [tailscale-access.md](./tailscale-access.md).

### Option B: Traefik ingress (public access)

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

Fix: Verify the image tag exists in GHCR and the pull secret is configured. If GHCR packages are private, either make them public or use the local build workaround in Step 1.

### control-plane CrashLoopBackOff

```bash
kubectl -n cortex logs deploy/control-plane --previous
```

Common causes:
- Missing `control-plane-secrets` secret
- Unreachable Postgres (check `DATABASE_URL`)
- Missing migrations directory in the image (ensure `COPY --from=builder /app/packages/control-plane/migrations` is in the Dockerfile runtime stage)

### Qdrant CrashLoopBackOff

```bash
kubectl -n cortex logs deploy/qdrant --previous
```

Common causes:
- Config conflicts: the qdrant configmap must not override defaults that conflict with the Qdrant version. Keep `production.yaml` minimal (service settings only).
- `ReadOnlyFilesystem` errors: ensure the deployment has an `emptyDir` volume mounted at `/qdrant/snapshots` (Qdrant writes snapshot metadata even when snapshots are not used).

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
- [ ] Access configured: Tailscale proxy (recommended) or Traefik ingress
- [ ] Tailscale verification script passes (`./scripts/tailscale-verify.sh cortex`)
