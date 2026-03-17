# Cortex Plane — Deployment Topology

## Infrastructure

| Component     | Host                                   | Details                                    |
| ------------- | -------------------------------------- | ------------------------------------------ |
| Proxmox VE    | lnx-pegasus                            | Hypervisor for all VMs                     |
| k3s cluster   | `cortex-plane` VM (VMID 110)           | 8GB RAM, 80GB disk, IP 10.244.7.110        |
| Dashboard URL | `https://cortex-demo.tail0c4aa.ts.net` | Exposed via Tailscale proxy                |
| GHA Runner    | On the `cortex-plane` VM               | Labels: `[self-hosted, linux, cortex-k3s]` |

## Kubernetes (namespace: `cortex`)

| Pod                         | Purpose                        |
| --------------------------- | ------------------------------ |
| `control-plane`             | Fastify API server (port 4000) |
| `dashboard`                 | Next.js frontend (port 3000)   |
| `postgresql-{1,2,3}`        | CloudNativePG 3-node cluster   |
| `postgresql-rw-pooler` (x2) | PgBouncer connection pooling   |
| `qdrant`                    | Vector database                |
| `tailscale-proxy`           | Ingress via Tailscale          |

## CI/CD Pipeline

```
Push to main
  → GHA: Build & Publish Images (docker-publish.yml)
    → Builds: cortex-control-plane, cortex-dashboard, playwright-sidecar
    → Pushes to: ghcr.io/noncelogic/cortex-*
  → GHA: Deploy to k3s (deploy-self-hosted.yml)
    → Runs on self-hosted runner
    → Kustomize overlay: deploy/k8s/overlays/prod
    → Script: scripts/deploy-k3s.sh
```

## SSH Access

```bash
ssh cortex-plane                          # Direct to the VM
ssh cortex-plane 'k3s kubectl get pods -n cortex'  # Check pods
ssh cortex-plane 'k3s kubectl logs -n cortex deployment/control-plane --tail=50'
```

## Secrets (k8s `control-plane-secrets`)

| Key                          | Purpose                                       | Required |
| ---------------------------- | --------------------------------------------- | -------- |
| `DATABASE_URL`               | CloudNativePG pooler connection               | Yes      |
| `CREDENTIAL_MASTER_KEY`      | AES-256-GCM encryption for stored credentials | Yes      |
| `OAUTH_GITHUB_CLIENT_ID`     | Dashboard login                               | Yes      |
| `OAUTH_GITHUB_CLIENT_SECRET` | Dashboard login                               | Yes      |

**Optional env vars** (LLM OAuth):

- `OAUTH_<PROVIDER>_CLIENT_ID` — set to enable the provider (see `.env.example`)
- `OAUTH_<PROVIDER>_CLIENT_SECRET` — optional for PKCE-only providers (Anthropic, Codex, Gemini CLI, Antigravity)
- LLM API keys — stored per-user in DB, encrypted with `CREDENTIAL_MASTER_KEY`

## ConfigMaps

| ConfigMap              | Key Values                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `control-plane-config` | `DASHBOARD_URL`, `QDRANT_URL`, `PORT=4000`, `LOG_LEVEL`, `NODE_ENV` |
| `dashboard-config`     | `CORTEX_API_URL=http://control-plane:4000`, `PORT=3000`             |

## Manual Operations

```bash
# Restart control-plane after secret/config changes
ssh cortex-plane 'k3s kubectl rollout restart deployment/control-plane -n cortex'

# Restart dashboard
ssh cortex-plane 'k3s kubectl rollout restart deployment/dashboard -n cortex'

# Check deployment image versions
ssh cortex-plane 'k3s kubectl get deployments -n cortex -o jsonpath="{range .items[*]}{.metadata.name}: {.spec.template.spec.containers[0].image}{\"\\n\"}{end}"'

# Trigger manual deploy
gh workflow run "Deploy to k3s (self-hosted)" --repo noncelogic/cortex-plane
```
