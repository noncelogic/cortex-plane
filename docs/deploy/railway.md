# Railway / PaaS Deployment Checklist

Host-agnostic service contract and mapping for deploying Cortex Plane on Railway or similar PaaS (Render, Fly.io, etc.).

## Service Contract

| Service | Image / Build | Port | Health Endpoint | Volumes | Required Env |
|---|---|---|---|---|---|
| control-plane | `Dockerfile.control-plane` | 4000 | `GET /healthz`, `GET /readyz` | — | `DATABASE_URL`, `QDRANT_URL` |
| dashboard | `Dockerfile.dashboard` | 3000 | `GET /` | — | `CORTEX_API_URL` |
| postgres | Managed (Railway Postgres) | 5432 | — | Persistent | — |
| qdrant | `qdrant/qdrant:v1.13.2` | 6333 | `GET /healthz` | Persistent | — |

## Railway Deployment Steps

### 1. Create project

Create a new Railway project with these services:

- **Postgres** — use Railway's managed Postgres plugin
- **Qdrant** — deploy as a Docker service from `qdrant/qdrant:v1.13.2`
- **control-plane** — deploy from repo with custom Dockerfile
- **dashboard** — deploy from repo with custom Dockerfile

### 2. Configure control-plane

| Setting | Value |
|---|---|
| Root Directory | `.` |
| Dockerfile Path | `deploy/docker/Dockerfile.control-plane` |
| Port | `4000` |
| Health Check | `GET /healthz` |

Environment variables:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
QDRANT_URL=http://${{Qdrant.RAILWAY_PRIVATE_DOMAIN}}:6333
PORT=4000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
GRAPHILE_WORKER_CONCURRENCY=5
```

### 3. Configure dashboard

| Setting | Value |
|---|---|
| Root Directory | `.` |
| Dockerfile Path | `deploy/docker/Dockerfile.dashboard` |
| Port | `3000` |
| Health Check | `GET /` |

Environment variables:

```
CORTEX_API_URL=http://${{control-plane.RAILWAY_PRIVATE_DOMAIN}}:4000
NEXT_PUBLIC_CORTEX_API_URL=https://<your-public-domain>/api
HOSTNAME=0.0.0.0
PORT=3000
NODE_ENV=production
```

### 4. Configure Qdrant

| Setting | Value |
|---|---|
| Image | `qdrant/qdrant:v1.13.2` |
| Port | `6333` |
| Volume | Mount at `/qdrant/storage` |
| Health Check | `GET /healthz` |

### 5. Networking

- Expose **dashboard** publicly (assign domain)
- Keep **control-plane**, **postgres**, and **qdrant** as private services
- If dashboard proxies API requests, the `CORTEX_API_URL` should use Railway's private networking

### 6. Verify

```bash
# Dashboard
curl https://your-domain.railway.app/

# Control-plane health (via dashboard proxy)
curl https://your-domain.railway.app/api/healthz
```

## Key Differences from k3s

| Concern | k3s | Railway |
|---|---|---|
| Networking | ClusterIP + Ingress | Railway private networking |
| TLS | cert-manager + traefik | Automatic |
| Persistent storage | local-path PVCs | Railway volumes |
| Secrets | k8s Secrets | Railway service variables |
| Scaling | Manual replicas | Railway scaling settings |
| Logs | `kubectl logs` | Railway dashboard / CLI |

## No k3s-Only Dependencies

The core demo path has no hidden k3s-only dependencies:

- All services use standard HTTP health checks
- Configuration is 100% environment-variable driven
- Dockerfiles are standard multi-stage builds
- No Kubernetes-specific init containers or sidecars required for the demo path
- The `@kubernetes/client-node` dependency in control-plane is only used for agent pod management, which is optional
