# Cortex Plane

AI agent control plane — orchestrates autonomous agents with chat-first interaction, multi-turn conversation, tool use, and a real-time operational dashboard.

Agents receive messages via Telegram, Discord, or REST API. The control plane routes messages to the right agent, manages conversation sessions, dispatches execution to LLM backends (Anthropic Claude, OpenAI), and streams responses back — with built-in tools, approval gates, memory, and job tracking.

## Architecture

````text
  Telegram / Discord / REST API
              │
              ▼
┌──────────────────────────────┐
│       Control Plane          │
│                              │
│  adapter → router → session  │
│     → enqueue → execute      │
│        → respond             │
│                              │
│  Fastify · Graphile Worker   │
│  PostgreSQL · Qdrant         │
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│     Execution Backends       │
│  Anthropic · OpenAI · CLI    │
│  Agentic loop with tools     │
└──────────────────────────────┘
              │
              ▼
┌──────────────────────────────┐
│        Dashboard             │
│  Next.js 15 · SSE streaming  │
│  Agents · Jobs · Approvals   │
│  Memory · Browser · Settings │
└──────────────────────────────┘
```text

## Quick Start (local dev)

```bash
# 1. Clone & install
git clone <repo-url> && cd cortex-plane
pnpm install

# 2. Copy environment config
cp .env.example .env
# Edit .env — set at minimum:
#   DATABASE_URL (default works with docker compose)
#   ANTHROPIC_API_KEY or OPENAI_API_KEY (for LLM execution)

# 3. Start infrastructure (postgres + qdrant)
make up
# or: docker compose up -d

# 4. Run migrations & seed
make db-migrate
make db-seed

# 5. Start dev servers (control-plane :4000 + dashboard :3100)
make dev
````

### Create an agent and send it a message

```bash
# Create an agent
curl -X POST http://localhost:4000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Research Assistant",
    "slug": "research-assistant",
    "role": "researcher",
    "description": "Answers questions using web search and reasoning",
    "model_config": { "model": "claude-sonnet-4-5-20250514" },
    "skill_config": { "allowedTools": ["web_search", "memory_query"] }
  }'

# Send a chat message (sync mode — waits for response)
curl -X POST http://localhost:4000/agents/<agent-id>/chat?wait=true \
  -H "Content-Type: application/json" \
  -d '{ "text": "What is the latest news about AI safety?" }'

# Send a chat message (async mode — returns job ID)
curl -X POST http://localhost:4000/agents/<agent-id>/chat \
  -H "Content-Type: application/json" \
  -d '{ "text": "Summarize recent developments in quantum computing" }'
# Response: { "job_id": "...", "session_id": "...", "status": "SCHEDULED" }
```

### Connect a Telegram bot

```bash
# 1. Set TELEGRAM_BOT_TOKEN in .env and restart

# 2. Bind agent to a Telegram chat
curl -X POST http://localhost:4000/agents/<agent-id>/channels \
  -H "Content-Type: application/json" \
  -d '{ "channel_type": "telegram", "chat_id": "<telegram-chat-id>" }'

# Now messages in that Telegram chat route to the agent
```

### Full stack via Docker Compose

Run everything in containers (including dashboard):

```bash
make up-full
# Services: postgres :5432, qdrant :6333, control-plane :4000, dashboard :3000
```

## How It Works

1. **Message arrives** from Telegram, Discord, or `POST /agents/:agentId/chat`
2. **MessageRouter** resolves the user's identity across channels
3. **AgentChannelService** finds the bound agent (direct binding or default)
4. **Session** is found or created, conversation history loaded (last 50 messages)
5. **Job enqueued** via Graphile Worker (`CHAT_RESPONSE` type)
6. **Execution backend** runs the agentic loop: LLM call → tool use → LLM call → response
7. **Response streams** back to the chat channel + dashboard SSE
8. **Memory extraction** runs asynchronously on conversation output

### Tools

Agents can use built-in tools during execution:

| Tool           | Description                              |
| -------------- | ---------------------------------------- |
| `web_search`   | Search the web via Brave Search API      |
| `http_request` | Make HTTP requests (GET/POST/PUT/DELETE) |
| `memory_query` | Query agent's vector memory (Qdrant)     |
| `memory_store` | Store facts in agent's vector memory     |

Agents can also have custom **webhook tools** defined in their config — these call external HTTP endpoints when the LLM invokes them. See `agent.config.tools` in the API.

## Make Targets

| Target            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `make up`         | Start infra services (postgres, qdrant, control-plane) |
| `make up-full`    | Start full stack including dashboard                   |
| `make down`       | Stop all services                                      |
| `make logs`       | Tail logs for all services                             |
| `make dev`        | Start dev servers with hot reload                      |
| `make build`      | Build all packages                                     |
| `make test`       | Run all tests                                          |
| `make lint`       | Lint all packages                                      |
| `make db-migrate` | Run database migrations                                |
| `make db-seed`    | Seed database with sample data                         |
| `make smoke`      | Run smoke tests against running stack                  |
| `make preflight`  | Pre-deployment checklist                               |
| `make clean`      | Remove build artifacts and volumes                     |

## Project Structure

```
cortex-plane/
├── packages/
│   ├── control-plane/     # Fastify API + Graphile Worker
│   ├── dashboard/         # Next.js 15 frontend
│   ├── shared/            # Shared types, backends, channel contracts
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

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable                | Required | Default                            | Description                           |
| ----------------------- | -------- | ---------------------------------- | ------------------------------------- |
| `DATABASE_URL`          | Yes      | `postgres://...localhost:5432/...` | PostgreSQL connection string          |
| `ANTHROPIC_API_KEY`     | \*       | —                                  | Anthropic API key (for Claude)        |
| `OPENAI_API_KEY`        | \*       | —                                  | OpenAI API key (alternative)          |
| `QDRANT_URL`            | No       | `http://localhost:6333`            | Qdrant vector store URL               |
| `PORT`                  | No       | `4000`                             | Control-plane HTTP port               |
| `LOG_LEVEL`             | No       | `info`                             | Pino log level                        |
| `TELEGRAM_BOT_TOKEN`    | No       | —                                  | Enables Telegram adapter              |
| `DISCORD_BOT_TOKEN`     | No       | —                                  | Enables Discord adapter               |
| `CREDENTIAL_MASTER_KEY` | No       | —                                  | Enables OAuth + credential encryption |
| `CORTEX_API_URL`        | No       | `http://localhost:4000`            | Dashboard → control-plane URL         |

\*At least one LLM API key is required for agent execution.

Full list with descriptions: [`.env.example`](.env.example)

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

Migration checklist: [docs/deploy/portability.md](docs/deploy/portability.md)

### CI Image Builds

On push to `main`, GitHub Actions builds and publishes images to GHCR:

- `ghcr.io/<owner>/cortex-control-plane:<sha>`
- `ghcr.io/<owner>/cortex-dashboard:<sha>`

See `.github/workflows/docker-publish.yml`.

## Documentation

| Document                                                                                 | Description                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [docs/VISION.md](docs/VISION.md)                                                         | Design philosophy and architecture                                                 |
| [docs/STATUS.md](docs/STATUS.md)                                                         | Implementation status tracker                                                      |
| [docs/spec.md](docs/spec.md)                                                             | Full architecture specification (v1.1.0)                                           |
| [docs/ops/engineering-operating-contract.md](docs/ops/engineering-operating-contract.md) | Issue intake, PR gates, deployment-debug expectations, and flow convergence policy |
| [docs/ops/openclaw-flow-parity-map.md](docs/ops/openclaw-flow-parity-map.md)             | OpenClaw-aligned flow parity surfaces and convergence evidence model               |
| [docs/ops/working-feature-velocity-loop.md](docs/ops/working-feature-velocity-loop.md)   | Working-feature speed loop and lead-time outcome expectations                      |
| [docs/spikes/](docs/spikes/)                                                             | Design spikes and decision records                                                 |
| [docs/deploy/](docs/deploy/)                                                             | Deployment runbooks (k3s, Railway)                                                 |

## License

MIT
