# Cortex Plane — development & operations targets
# Run `make help` for usage.

COMPOSE  := docker compose
PROFILES := --profile full
REGISTRY ?= ghcr.io/noncelogic
TAG      ?= $(shell git rev-parse --short HEAD)

.PHONY: help up up-app up-full down logs ps \
        build dev test lint typecheck format \
        db-migrate db-seed \
        smoke preflight docker-build docker-push clean

# ---------------------------------------------------------------------------
# Docker Compose
# ---------------------------------------------------------------------------

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

up: ## Start infra only (postgres + qdrant)
	$(COMPOSE) up -d

up-app: ## Start infra + control-plane
	$(COMPOSE) --profile app up -d

up-full: ## Start full stack including dashboard
	$(COMPOSE) $(PROFILES) up -d --build

down: ## Stop all services and remove orphans
	$(COMPOSE) $(PROFILES) down --remove-orphans

logs: ## Tail logs for all running services
	$(COMPOSE) $(PROFILES) logs -f

ps: ## Show running service status
	$(COMPOSE) $(PROFILES) ps

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

build: ## Build all packages (turbo)
	pnpm build

dev: ## Start dev servers (control-plane + dashboard with hot reload)
	pnpm dev

test: ## Run all tests
	pnpm test

lint: ## Lint all packages
	pnpm lint

typecheck: ## Type-check all packages
	pnpm typecheck

format: ## Auto-format all files
	pnpm format

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

db-migrate: ## Run database migrations
	pnpm db:migrate

db-seed: ## Seed database with sample data
	pnpm --filter @cortex/control-plane run db:seed

# ---------------------------------------------------------------------------
# Image builds
# ---------------------------------------------------------------------------

docker-build: ## Build all container images (TAG=sha default)
	docker build -t $(REGISTRY)/cortex-control-plane:$(TAG) -f deploy/docker/Dockerfile.control-plane .
	docker build -t $(REGISTRY)/cortex-dashboard:$(TAG) -f deploy/docker/Dockerfile.dashboard .
	docker build -t $(REGISTRY)/cortex-playwright-sidecar:$(TAG) -f deploy/docker/Dockerfile.playwright-sidecar .

docker-push: ## Push all images to registry
	docker push $(REGISTRY)/cortex-control-plane:$(TAG)
	docker push $(REGISTRY)/cortex-dashboard:$(TAG)
	docker push $(REGISTRY)/cortex-playwright-sidecar:$(TAG)

# ---------------------------------------------------------------------------
# Deployment & operations
# ---------------------------------------------------------------------------

smoke: ## Run smoke tests against running compose stack
	./scripts/smoke-test.sh

preflight: ## Run pre-deploy checks (config, secrets, images)
	./scripts/preflight-deploy.sh

clean: ## Remove build artifacts, volumes, caches
	pnpm clean
	$(COMPOSE) $(PROFILES) down -v --remove-orphans
	rm -rf .turbo
