# Host Portability & Railway Deployment

Cortex Plane is designed to run anywhere containers run. This document defines the service contract, maps it to Railway, and provides a checklist for migrating to any PaaS.

---

## Service Contract

| Service       | Port                     | Health Endpoint                                                                      | Required Env Vars                                   | Optional Env Vars                                                                                             | Volumes                                 | Image                                     |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| control-plane | 4000                     | `/healthz` (liveness), `/readyz` (readiness), `/health/backends` (dependency status) | `DATABASE_URL`                                      | `QDRANT_URL`, `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`, `GRAPHILE_WORKER_CONCURRENCY`, `CREDENTIAL_MASTER_KEY` | None                                    | `ghcr.io/noncelogic/cortex-control-plane` |
| dashboard     | 3000                     | `/` (returns 200)                                                                    | `CORTEX_API_URL` (server-side API base)             | `HOSTNAME`, `PORT`, `NODE_ENV`, `NEXT_PUBLIC_CORTEX_API_URL` (client-side API base)                           | None                                    | `ghcr.io/noncelogic/cortex-dashboard`     |
| PostgreSQL    | 5432                     | `pg_isready`                                                                         | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | --                                                                                                            | `/var/lib/postgresql/data` (persistent) | `postgres:17-bookworm`                    |
| Qdrant        | 6333 (HTTP), 6334 (gRPC) | `/healthz`                                                                           | --                                                  | Config via `production.yaml` mount                                                                            | `/qdrant/storage` (persistent)          | `qdrant/qdrant:v1.13.2`                   |

### Key Points

- **control-plane** is the only service that connects to both Postgres and Qdrant. All other services talk only to control-plane.
- **dashboard** connects to control-plane via `CORTEX_API_URL` (server-side requests) and exposes `NEXT_PUBLIC_CORTEX_API_URL` to the browser (client-side requests).
- Neither control-plane nor dashboard require persistent volumes. Only Postgres and Qdrant need persistent storage.

---

## Railway Deployment Mapping

Each service maps to a separate Railway service within a single Railway project:

| Cortex Service | Railway Service Type     | Build                                    | Notes                                                                      |
| -------------- | ------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| control-plane  | Docker (Dockerfile)      | `deploy/docker/Dockerfile.control-plane` | Set root directory to repo root                                            |
| dashboard      | Docker (Dockerfile)      | `deploy/docker/Dockerfile.dashboard`     | Set root directory to repo root                                            |
| PostgreSQL     | Railway Managed Postgres | --                                       | Use Railway's built-in Postgres plugin (v17)                               |
| Qdrant         | Docker or External       | `qdrant/qdrant:v1.13.2`                  | Deploy as a Railway Docker service, or use a managed Qdrant Cloud instance |

### railway.json (per service)

For control-plane:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "dockerfilePath": "deploy/docker/Dockerfile.control-plane"
  },
  "deploy": {
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

For dashboard:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "dockerfilePath": "deploy/docker/Dockerfile.dashboard"
  },
  "deploy": {
    "healthcheckPath": "/",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

---

## Environment Variable Mapping

### control-plane

| Variable                      | Railway Value                         | Notes                                                    |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                | `${{Postgres.DATABASE_URL}}`          | Railway reference variable from managed Postgres         |
| `QDRANT_URL`                  | `http://qdrant.railway.internal:6333` | Railway private networking, or external Qdrant Cloud URL |
| `PORT`                        | `4000`                                | Railway auto-detects from Dockerfile EXPOSE              |
| `HOST`                        | `0.0.0.0`                             | Required for Railway to reach the service                |
| `NODE_ENV`                    | `production`                          | --                                                       |
| `LOG_LEVEL`                   | `info`                                | --                                                       |
| `GRAPHILE_WORKER_CONCURRENCY` | `5`                                   | Adjust based on Railway plan CPU                         |
| `CREDENTIAL_MASTER_KEY`       | (set manually)                        | 32-byte hex key for credential encryption                |

### dashboard

| Variable                     | Railway Value                                          | Notes                               |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `CORTEX_API_URL`             | `http://control-plane.railway.internal:4000`           | Private networking for SSR requests |
| `NEXT_PUBLIC_CORTEX_API_URL` | `https://control-plane-production-XXXX.up.railway.app` | Public URL for browser requests     |
| `HOSTNAME`                   | `0.0.0.0`                                              | --                                  |
| `PORT`                       | `3000`                                                 | --                                  |
| `NODE_ENV`                   | `production`                                           | --                                  |

---

## Managed Database Assumptions

### PostgreSQL (Railway Managed)

- Railway provides Postgres 17 as a plugin. No container to manage.
- `DATABASE_URL` is injected automatically via Railway reference variables.
- Backups are handled by Railway (point-in-time recovery on paid plans).
- Run migrations on first deploy:
  ```bash
  railway run pnpm db:migrate
  ```

### Qdrant (Managed or Self-Hosted)

- **Option A: Railway Docker service.** Deploy `qdrant/qdrant:v1.13.2` as its own service. Attach a Railway volume mounted at `/qdrant/storage`.
- **Option B: Qdrant Cloud.** Use a managed Qdrant cluster and set `QDRANT_URL` to the external endpoint. No Railway service needed.

---

## What NOT to Assume

The core application path (control-plane + dashboard) does **not** depend on any Kubernetes-specific primitives:

- No reliance on Kubernetes Services for DNS (use environment variables for service URLs)
- No reliance on ConfigMaps or Secrets objects (use platform-native env vars)
- No reliance on PersistentVolumeClaims for application services (only infra services need volumes)
- No reliance on kustomize overlays at runtime
- No reliance on Kubernetes health check types (standard HTTP health endpoints work on any platform)
- No reliance on Kubernetes RBAC, NetworkPolicy, or SecurityContext (these are defense-in-depth, not functional requirements)

The k8s manifests in `deploy/k8s/` are deployment-target-specific and should not be treated as the source of truth for application configuration.

---

## PaaS Migration Checklist

Use this checklist when deploying to any new PaaS (Render, Fly.io, Google Cloud Run, etc.):

1. **Postgres**: Provision a managed Postgres 17 instance. Record the connection string.

2. **Qdrant**: Decide between self-hosted (container with persistent volume) or Qdrant Cloud. Record the endpoint URL.

3. **control-plane service**:
   - [ ] Build from `deploy/docker/Dockerfile.control-plane` (context = repo root)
   - [ ] Set `DATABASE_URL` to the Postgres connection string
   - [ ] Set `QDRANT_URL` to the Qdrant endpoint
   - [ ] Set `PORT=4000`, `HOST=0.0.0.0`, `NODE_ENV=production`
   - [ ] Set `CREDENTIAL_MASTER_KEY` (generate with `openssl rand -hex 32`)
   - [ ] Configure health check on `/healthz`
   - [ ] Run migrations: `node packages/control-plane/dist/migrate.js`

4. **dashboard service**:
   - [ ] Build from `deploy/docker/Dockerfile.dashboard` (context = repo root)
   - [ ] Set `CORTEX_API_URL` to the control-plane internal/private URL
   - [ ] Set `NEXT_PUBLIC_CORTEX_API_URL` to the control-plane public URL
   - [ ] Set `HOSTNAME=0.0.0.0`, `PORT=3000`, `NODE_ENV=production`
   - [ ] Configure health check on `/`

5. **Networking**:
   - [ ] Expose dashboard publicly (port 3000)
   - [ ] Expose control-plane publicly if API is accessed directly (port 4000), or route `/api` through a reverse proxy
   - [ ] Ensure control-plane can reach Postgres and Qdrant on their respective ports

6. **Verification**:
   - [ ] `curl <control-plane-url>/healthz` returns 200
   - [ ] `curl <control-plane-url>/readyz` returns 200
   - [ ] `curl <dashboard-url>/` returns 200
   - [ ] Dashboard can reach control-plane from the browser (check `NEXT_PUBLIC_CORTEX_API_URL`)
