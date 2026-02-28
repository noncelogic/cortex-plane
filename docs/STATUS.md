# Cortex Plane — Implementation Status

**Last updated:** 2026-02-28
**Spec version:** 1.1.0

This document tracks what's built, what's in progress, and what's missing relative to the [architecture spec](./spec.md). It's the source of truth for "where are we?"

---

## Legend

- ✅ **Built** — implemented, tested, deployed
- 🔧 **Partial** — code exists but not wired / not complete
- ❌ **Missing** — not started
- 🚫 **Deferred** — intentionally postponed

---

## Core Infrastructure

| Component                | Status | Notes                                                |
| ------------------------ | ------ | ---------------------------------------------------- |
| PostgreSQL (single-node) | ✅     | CNPG operator v1.25.1 on k3s                         |
| Auto-migrations          | ✅     | Kysely migrations run on startup                     |
| Graphile Worker          | ✅     | Job orchestrator, task dispatch                      |
| Fastify HTTP server      | ✅     | Control plane API                                    |
| k3s cluster              | ✅     | Self-hosted on Proxmox VM                            |
| CI/CD pipeline           | ✅     | GHA → Docker build → k3s deploy (self-hosted runner) |
| Tailscale access         | ✅     | `cortex-demo.tail0c4aa.ts.net`                       |
| Qdrant vector store      | ✅     | Deployed, schema ready                               |
| OpenTelemetry tracing    | 🔧     | Config exists, not actively used                     |
| PostgreSQL HA (CNPG)     | 🚫     | Phase 2 — single-node sufficient                     |

## Authentication & Credentials

| Component                             | Status | Notes                                      |
| ------------------------------------- | ------ | ------------------------------------------ |
| OAuth login (GitHub)                  | ✅     | Cookie-based sessions, configured in k8s   |
| OAuth login (Google)                  | 🔧     | Backend supports it, not configured in k8s |
| Session management                    | ✅     | httpOnly cookies, CSRF tokens              |
| Credential encryption                 | ✅     | AES-GCM per-user keys                      |
| LLM provider OAuth (Antigravity)      | ✅     | Code-paste flow working                    |
| LLM provider OAuth (Codex, Anthropic) | 🔧     | Code exists but broken — doesn't reach SSO |
| API key storage (OpenAI, Google AI)   | ✅     | Encrypted in DB                            |

## Agent System

| Component                      | Status | Notes                                                |
| ------------------------------ | ------ | ---------------------------------------------------- |
| Agent registry (CRUD)          | ✅     | Create, list, get, update, delete                    |
| Agent lifecycle state machine  | ✅     | PROVISIONING → BOOTING → READY → ACTIVE → ...        |
| Lifecycle health monitoring    | ✅     | Heartbeat-based health detection                     |
| Idle detection                 | ✅     | Auto-pause after inactivity                          |
| **Agent execution (LLM call)** | ❌     | **Backends exist but not wired to inbound messages** |
| **Sub-agent spawning**         | ❌     | **No parent→child agent orchestration**              |
| **Tool framework**             | ❌     | **Agents have no tools (exec, file, web, etc.)**     |
| Per-agent k8s pods             | 🔧     | Deployer code exists, not tested E2E                 |

## Chat Channels (Spec §15)

| Component                   | Status | Notes                                               |
| --------------------------- | ------ | --------------------------------------------------- |
| ChannelAdapter interface    | ✅     | Uniform contract for all platforms                  |
| Telegram adapter            | ✅     | grammY-based, tested                                |
| Discord adapter             | ✅     | discord.js-based, tested                            |
| MessageRouter               | ✅     | User identity resolution, auto-provisioning         |
| ChannelSupervisor           | ✅     | Health monitoring, circuit breaker, auto-reconnect  |
| ChannelAdapterRegistry      | ✅     | Lifecycle management                                |
| **Startup wiring**          | ❌     | **Nothing instantiates adapters at runtime (#231)** |
| **Agent ↔ channel binding** | ❌     | **No mapping from chat → agent (#232)**             |
| Slack adapter               | ❌     | Not started                                         |
| WhatsApp adapter            | ❌     | Not started                                         |

## Job System (Spec §6)

| Component                   | Status | Notes                                                |
| --------------------------- | ------ | ---------------------------------------------------- |
| Job state machine           | ✅     | PENDING → RUNNING → COMPLETED/FAILED/DEAD_LETTER     |
| Job CRUD API                | ✅     | List, get, retry                                     |
| Job SSE streaming           | ✅     | Real-time status updates                             |
| **Job creation from agent** | ❌     | **No code path: agent decision → create job (#233)** |
| Job retry logic             | ✅     | Configurable retry with backoff                      |
| Worker error classification | ✅     | Transient vs permanent failure detection             |

## Approval Gates (Spec §9)

| Component                       | Status | Notes                             |
| ------------------------------- | ------ | --------------------------------- |
| Approval request creation       | ✅     | API + DB schema                   |
| Approve/reject API              | ✅     | With audit trail                  |
| Risk tier classification        | ✅     | Hamel's approval risk tiers       |
| Telegram approval notifications | ✅     | Inline approve/reject buttons     |
| Approval expiration             | ✅     | Graphile Worker task              |
| **Triggered by agent actions**  | ❌     | **No agent → approval gate flow** |

## Memory System (Spec §8, §17)

| Component                              | Status | Notes                                          |
| -------------------------------------- | ------ | ---------------------------------------------- |
| Memory extraction prompt               | ✅     | LLM-based extraction from conversations        |
| Memory scheduling                      | ✅     | Threshold-based extraction trigger             |
| Memory search API                      | ✅     | Full-text search with agent_id filter          |
| Qdrant vector storage                  | 🔧     | Schema deployed, not populated                 |
| **Extraction from live conversations** | ❌     | **No conversations happening → no extraction** |

## Browser Orchestration (Spec §14)

| Component                    | Status | Notes                                  |
| ---------------------------- | ------ | -------------------------------------- |
| Browser session API          | ✅     | Status, heartbeat                      |
| Screenshot capture           | ✅     | API endpoint                           |
| Trace recording (start/stop) | ✅     | Playwright trace integration           |
| Browser events API           | ✅     | Event timeline                         |
| Auth handoff                 | ✅     | Cookie/credential injection            |
| **Agent launches browser**   | ❌     | **No agent → Playwright session flow** |

## Dashboard

| Component                      | Status | Notes                                             |
| ------------------------------ | ------ | ------------------------------------------------- |
| Login page                     | ✅     | GitHub OAuth                                      |
| Auth guard (all routes)        | ✅     | 4-state auth model                                |
| Agent list + detail            | ✅     | Grid/table view, lifecycle, metrics               |
| Jobs page                      | ✅     | Filters, SSE, export                              |
| Approvals page                 | ✅     | Approve/reject, audit drawer                      |
| Memory explorer                | ✅     | Search, viewer, editor                            |
| Browser observation            | ✅     | Screenshots, VNC, trace controls                  |
| Pulse (content pipeline)       | ✅     | Archive, detail drawer, SSE                       |
| Settings (providers)           | ✅     | OAuth connect, API key entry                      |
| **Settings (channels)**        | ❌     | **No UI for chat channel config**                 |
| **Settings (login providers)** | ❌     | **Env-var only, no UI**                           |
| **Empty state handling**       | ❌     | **Crashes/errors instead of helpful CTAs (#234)** |
| User menu                      | ✅     | Profile, theme toggle, logout                     |

## Scheduling

| Component                     | Status | Notes                                    |
| ----------------------------- | ------ | ---------------------------------------- |
| Graphile Worker tasks         | ✅     | Job dispatch infrastructure              |
| **User-facing scheduling**    | ❌     | **No "check this every hour" from chat** |
| **Cron-like recurring tasks** | ❌     | **No agent-level scheduling**            |

## Content Pipeline (Pulse)

| Component                        | Status | Notes                                  |
| -------------------------------- | ------ | -------------------------------------- |
| Content piece CRUD               | 🔧     | Schema + API, no content generation    |
| Pipeline stages                  | ✅     | DRAFT → IN_REVIEW → QUEUED → PUBLISHED |
| Dashboard UI                     | ✅     | Board view, filters, SSE               |
| **Content generation by agents** | ❌     | **No agent → content flow**            |

---

## Critical Path to "Working Product"

These are the blocking items, in dependency order:

1. **#231 — Wire chat adapters at startup** (adapters exist, need startup glue)
2. **#232 — Agent ↔ channel binding** (route messages to the right agent)
3. **#233 — Wire execution backend** (agent receives message → calls LLM → creates jobs)
4. **#234 — Dashboard empty states** (graceful degradation)

After 1-3, the full loop works: chat → agent → jobs → approvals → memory → dashboard.

---

## Spec Sections vs Implementation

| Spec Section              | Impl Status | Gap                                                    |
| ------------------------- | ----------- | ------------------------------------------------------ |
| §4 System Architecture    | ✅          | —                                                      |
| §5 Control Plane          | ✅          | —                                                      |
| §6 Job State Machine      | 🔧          | Jobs exist but aren't created by agents                |
| §7 Agent Registry         | ✅          | —                                                      |
| §8 Memory System          | 🔧          | Infrastructure built, no live data                     |
| §9 Approval Gates         | 🔧          | Infrastructure built, not triggered by agents          |
| §10 Session Buffer        | ❌          | No conversation JSONL storage                          |
| §11 Orchestration         | ✅          | Graphile Worker operational                            |
| §12 Agent Lifecycle       | ✅          | —                                                      |
| §13 Security Model        | 🔧          | Auth done, pod security not tested                     |
| §14 Browser Orchestration | 🔧          | APIs built, no agent→browser trigger                   |
| §15 Channel Integration   | 🔧          | **Adapters built, not wired at runtime**               |
| §16 Voice Integration     | ❌          | Signaling routes exist, no implementation              |
| §17 Memory Extraction     | 🔧          | Pipeline built, no conversations to extract from       |
| §18 PostgreSQL            | ✅          | CNPG single-node                                       |
| §19 Observability         | 🔧          | Pino logging, OTel config exists                       |
| §20 LLM Failover          | 🔧          | Error classification done, circuit breaker code exists |
| §21 Skills Framework      | ❌          | Not started                                            |
| §22 Dashboard             | ✅          | All 7 screens built                                    |
| §23 Infrastructure        | ✅          | k3s + CI/CD + Tailscale                                |
