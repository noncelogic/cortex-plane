# Cortex Plane

AI agent control plane and dashboard — orchestrates agent lifecycles, manages credentials, and provides a real-time operational dashboard.

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌──────────┐
│  Dashboard   │────▶│  Control Plane   │────▶│ Postgres │
│ (Next.js 15) │     │  (Fastify)       │────▶│  Qdrant  │
└─────────────┘     └─────────────────┘     └──────────┘
     :3000               :4000              :5432 / :6333
```

## Quick Start (local dev)

```bash
# 1. Clone & install
git clone <repo-url> && cd cortex-plane
pnpm install

# 2. Copy environment config
cp .env.example .env

# 3. Start infrastructure (postgres + qdrant)
make up
# or: docker compose up -d

# 4. Run migrations & seed
make db-migrate
make db-seed

# 5. Start dev servers (control-plane :4000 + dashboard :3100)
make dev
```

### Full stack via Docker Compose

Run everything in containers (including dashboard):

```bash
make up-full
# Services: postgres :5432, qdrant :6333, control-plane :4000, dashboard :3000
```

## Make Targets

| Target | Description |
|---|---|
| `make up` | Start infra services (postgres, qdrant, control-plane) |
| `make up-full` | Start full stack including dashboard |
| `make down` | Stop all services |
| `make logs` | Tail logs for all services |
| `make dev` | Start dev servers with hot reload |
| `make build` | Build all packages |
| `make test` | Run all tests |
| `make lint` | Lint all packages |
| `make db-migrate` | Run database migrations |
| `make db-seed` | Seed database with sample data |
| `make smoke` | Run smoke tests against running stack |
| `make preflight` | Pre-deployment checklist |
| `make clean` | Remove build artifacts and volumes |

## Project Structure

```
cortex-plane/
├── packages/
│   ├── control-plane/     # Fastify API server
│   ├── dashboard/         # Next.js 15 frontend
│   ├── shared/            # Shared utilities & types
│   ├── agent-cdp/         # Chrome DevTools Protocol agent
│   ├── adapter-discord/   # Discord bot adapter
│   └── adapter-telegram/  # Telegram bot adapter
├── deploy/
│   ├── docker/            # Dockerfiles
│   └── k8s/               # Kubernetes manifests (kustomize)
├── scripts/               # Operational scripts
├── docs/                  # Documentation
└── .github/workflows/     # CI/CD pipelines
```

## Deployment

### Docker Compose (dev / demo)

See [Quick Start](#quick-start-local-dev) above. The compose file includes healthchecks and deterministic startup ordering.

### Kubernetes (k3s)

Full runbook: [docs/deploy/k3s.md](docs/deploy/k3s.md)

```bash
# Quick deploy to existing cluster
kubectl apply -k deploy/k8s/overlays/dev/
```

### Railway / PaaS

Migration checklist: [docs/deploy/railway.md](docs/deploy/railway.md)

### CI Image Builds

On push to `main`, GitHub Actions builds and publishes images to GHCR:

- `ghcr.io/<owner>/cortex-control-plane:<sha>`
- `ghcr.io/<owner>/cortex-dashboard:<sha>`

See `.github/workflows/docker-publish.yml`.

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `QDRANT_URL` | No | `http://localhost:6333` | Qdrant vector store URL |
| `PORT` | No | `4000` | Control-plane HTTP port |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `CREDENTIAL_MASTER_KEY` | No | — | Enables auth/OAuth features |
| `CORTEX_API_URL` | No | `http://localhost:4000` | Dashboard → control-plane URL |

Full list with descriptions: [`.env.example`](.env.example)

## License

MIT
