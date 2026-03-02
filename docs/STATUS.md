# Cortex Plane — Implementation Status

**Last updated:** 2026-03-02
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
| Auto-migrations          | ✅     | Kysely migrations run on startup (14 migrations)     |
| Graphile Worker          | ✅     | Job orchestrator, task dispatch                      |
| Fastify HTTP server      | ✅     | Control plane API (14 route modules)                 |
| k3s cluster              | ✅     | Self-hosted on Proxmox VM                            |
| CI/CD pipeline           | ✅     | GHA → Docker build → k3s deploy (self-hosted runner) |
| Tailscale access         | ✅     | `cortex-demo.tail0c4aa.ts.net`                       |
| Qdrant vector store      | ✅     | Deployed, schema ready                               |
| OpenTelemetry tracing    | 🔧     | Config exists, not actively used                     |
| PostgreSQL HA (CNPG)     | 🚫     | Phase 2 — single-node sufficient                     |

## Authentication & Credentials

| Component                        | Status | Notes                                             |
| -------------------------------- | ------ | ------------------------------------------------- |
| OAuth login (GitHub)             | ✅     | Cookie-based sessions, configured in k8s          |
| OAuth login (Google)             | 🔧     | Backend supports it, not configured in k8s        |
| Session management               | ✅     | httpOnly cookies, CSRF tokens                     |
| Credential encryption            | ✅     | AES-GCM per-user keys                             |
| LLM provider OAuth (Antigravity) | ✅     | Code-paste flow working                           |
| LLM provider OAuth (Anthropic)   | ✅     | PKCE code-paste flow, `code#state` format parsing |
| LLM provider OAuth (Codex)       | 🔧     | Code exists, not fully tested                     |
| API key storage (OpenAI, etc.)   | ✅     | Encrypted in DB, audit-logged                     |
| SSE stream auth                  | ✅     | Per-session Bearer token + cookie fallback        |

## Agent System

| Component                     | Status | Notes                                                            |
| ----------------------------- | ------ | ---------------------------------------------------------------- |
| Agent registry (CRUD)         | ✅     | Create, list, get, update, delete                                |
| Agent config (JSONB)          | ✅     | `model_config`, `skill_config`, `resource_limits`, `config` cols |
| Agent lifecycle state machine | ✅     | PROVISIONING → BOOTING → READY → ACTIVE → ...                    |
| Lifecycle health monitoring   | ✅     | Heartbeat-based health detection                                 |
| Idle detection                | ✅     | Auto-pause after inactivity                                      |
| Agent execution (LLM call)    | ✅     | Chat → dispatch → Graphile Worker → backend → LLM → response    |
| Agentic execution loop        | ✅     | Multi-turn tool calling with streaming output                    |
| Tool framework                | ✅     | Built-in tools + per-agent webhook tools (see below)             |
| Sub-agent spawning            | ❌     | No parent→child agent orchestration                              |
| Per-agent k8s pods            | 🔧     | Deployer code exists, not tested E2E                             |

## Tool Framework

| Component          | Status | Notes                                                        |
| ------------------ | ------ | ------------------------------------------------------------ |
| ToolRegistry       | ✅     | Register, resolve (allow/deny lists), execute                |
| `web_search`       | ✅     | Brave Search API integration                                 |
| `http_request`     | ✅     | GET/POST/PUT/PATCH/DELETE, blocks internal addrs, 1MB limit  |
| `memory_query`     | ✅     | Qdrant vector store scroll with metadata filtering           |
| `memory_store`     | ✅     | Write to Qdrant collection                                   |
| `echo`             | ✅     | Test tool — echoes input                                     |
| Webhook tools      | ✅     | Per-agent custom tools via `agent.config.tools` webhook spec |
| Per-agent registry | ✅     | Default tools + agent's webhook tools merged at execution    |

## Chat & Channels (Spec §15)

| Component               | Status | Notes                                                           |
| ------------------------ | ------ | --------------------------------------------------------------- |
| ChannelAdapter interface | ✅     | Uniform contract for all platforms                              |
| Telegram adapter         | ✅     | grammY-based, tested                                            |
| Discord adapter          | ✅     | discord.js-based, tested                                        |
| MessageRouter            | ✅     | User identity resolution, auto-provisioning                     |
| ChannelSupervisor        | ✅     | Health monitoring, circuit breaker, auto-reconnect              |
| ChannelAdapterRegistry   | ✅     | Lifecycle management                                            |
| Startup wiring           | ✅     | Adapters instantiated at boot, message router bound (#236–#244) |
| Agent ↔ channel binding  | ✅     | `agent_channel_binding` table, API routes, default agent lookup |
| Chat REST endpoint       | ✅     | `POST /agents/:agentId/chat` with sync/async modes             |
| Slack adapter            | ❌     | Not started                                                     |
| WhatsApp adapter         | ❌     | Not started                                                     |

## Session & Conversation (Spec §10)

| Component            | Status | Notes                                                       |
| -------------------- | ------ | ----------------------------------------------------------- |
| Session management   | ✅     | Per-agent, per-user, per-channel session scoping            |
| Session message store| ✅     | `session_message` table (role, content, metadata)           |
| Conversation history | ✅     | Loads last 50 messages for LLM context                      |
| Session CRUD API     | ✅     | List sessions, get messages, clear/reset session            |
| JSONL buffer writer  | ✅     | Streams execution output to session buffer for extraction   |

## Job System (Spec §6)

| Component               | Status | Notes                                                      |
| ------------------------ | ------ | ---------------------------------------------------------- |
| Job state machine        | ✅     | PENDING → SCHEDULED → RUNNING → COMPLETED/FAILED/TIMED_OUT |
| Job CRUD API             | ✅     | List, get, retry                                           |
| Job SSE streaming        | ✅     | Real-time status updates (route collision fixed, #269)     |
| Job creation from chat   | ✅     | Chat message → CHAT_RESPONSE job → enqueue                 |
| Job retry logic          | ✅     | Configurable retry with exponential backoff                |
| Worker error classifn    | ✅     | Transient/permanent/timeout/resource classification        |
| Job creation from agent  | ❌     | No code path: agent mid-execution → create sub-job         |

## Execution Backends

| Component            | Status | Notes                                                      |
| -------------------- | ------ | ---------------------------------------------------------- |
| BackendRegistry      | ✅     | Registration, lifecycle, health cache, WIP semaphores      |
| HttpLlmBackend       | ✅     | Anthropic Claude + OpenAI-compatible, streaming, tool loop |
| ClaudeCodeBackend    | ✅     | Spawns `claude` CLI, parses stream-json output             |
| EchoBackend          | ✅     | Test stub with configurable latency/failure rate           |
| Circuit breaker      | ✅     | Per-backend failure tracking, cascading failure protection |
| Provider router      | ✅     | Failover-aware backend selection by health + priority      |

## Approval Gates (Spec §9)

| Component                      | Status | Notes                                                  |
| ------------------------------ | ------ | ------------------------------------------------------ |
| Approval request creation      | ✅     | API + DB schema                                        |
| Approve/reject API             | ✅     | With audit trail                                       |
| Risk tier classification       | ✅     | Hamel's approval risk tiers                            |
| Telegram approval notifications| ✅     | Inline approve/reject buttons                          |
| Approval expiration            | ✅     | Graphile Worker task                                   |
| Approval gate in execution     | ✅     | `model_config.requiresApproval` blocks job until approved |
| Triggered by agent decisions   | ❌     | No agent self-initiated approval gate flow             |

## Memory System (Spec §8, §17)

| Component                      | Status | Notes                                          |
| ------------------------------ | ------ | ---------------------------------------------- |
| Memory extraction prompt       | ✅     | LLM-based extraction from conversations        |
| Memory scheduling              | ✅     | Threshold-based extraction trigger             |
| Memory search API              | ✅     | Full-text search with agent_id filter          |
| Qdrant vector storage          | 🔧     | Schema deployed, not populated at scale        |
| Memory tools (query/store)     | ✅     | Agents can read/write memory via tool calls    |
| Extraction from conversations  | 🔧     | Pipeline wired to execution output stream      |

## Browser Orchestration (Spec §14)

| Component                    | Status | Notes                                  |
| ---------------------------- | ------ | -------------------------------------- |
| Browser session API          | ✅     | Status, heartbeat                      |
| Screenshot capture           | ✅     | API endpoint + SSE screenshot stream   |
| Trace recording (start/stop) | ✅     | Playwright trace integration           |
| Browser events API           | ✅     | Event timeline                         |
| Auth handoff                 | ✅     | Cookie/credential injection            |
| **Agent launches browser**   | ❌     | **No agent → Playwright session flow** |

## Dashboard

| Component                | Status | Notes                                               |
| ------------------------ | ------ | --------------------------------------------------- |
| Login page               | ✅     | GitHub OAuth                                        |
| Auth guard (all routes)  | ✅     | 4-state auth model                                  |
| Agent list + detail      | ✅     | Grid/table view, lifecycle, metrics                 |
| Jobs page                | ✅     | Filters, SSE, export                                |
| Approvals page           | ✅     | Approve/reject, audit drawer                        |
| Memory explorer          | ✅     | Search, viewer, editor                              |
| Browser observation      | ✅     | Screenshots, VNC, trace controls                    |
| Pulse (content pipeline) | ✅     | Archive, detail drawer, SSE                         |
| Settings (providers)     | ✅     | OAuth connect, API key entry                        |
| Empty state handling     | ✅     | Shared `EmptyState` component, default + compact variants |
| User menu                | ✅     | Profile, theme toggle, logout                       |
| Settings (channels)      | ❌     | No UI for chat channel config                       |
| Settings (login providers)| ❌    | Env-var only, no UI                                 |

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

## What Was Shipped (PRs #236–#269)

The orchestration engine feature chain delivered the core runtime loop:

| PR    | Feature                                                  |
| ----- | -------------------------------------------------------- |
| #236  | Agent ↔ channel binding with contract tests              |
| #237  | Anthropic OAuth PKCE code-paste flow                     |
| #238  | SSE stream auth (per-session Bearer token)               |
| #242  | Agentic execution loop with tool calling                 |
| #243  | Built-in tools + per-agent webhook tool framework        |
| #244  | E2E chat flow: adapter → dispatch → session → execute    |
| #251  | Shared EmptyState component for dashboard                |
| #255  | Agent config JSONB column                                |
| #254  | Session buffer (`session_message` table + history)       |
| #256  | Tool framework wiring into execution                     |
| #269  | `/jobs/stream` route collision fix                        |

---

## Next Priorities

The core chat → agent → LLM → response loop is working. Remaining gaps:

1. **Agent-initiated job creation** — agents cannot spawn sub-jobs mid-execution
2. **Agent → browser session** — no tool to launch Playwright from the agentic loop
3. **Agent → approval gate** — agents cannot self-initiate approval requests
4. **Scheduling** — no cron/recurring task support from chat or API
5. **Content generation** — no agent → content pipeline integration
6. **Sub-agent spawning** — no parent→child orchestration
7. **Dashboard channel settings** — channel binding is API-only
8. **Skills framework** — not started

---

## Test Coverage

104 test files across 5 packages:

| Package          | Tests | Coverage Areas                                            |
| ---------------- | ----- | --------------------------------------------------------- |
| control-plane    | 57    | Routes, services, auth, chat, execution, lifecycle, tools |
| dashboard        | 13    | API client, auth, SSE, schemas, UI components             |
| shared           | 28    | Channels, routing, memory, skills, providers, schemas     |
| adapter-telegram | 3     | Adapter, config, formatter                                |
| adapter-discord  | 3     | Adapter, config, formatter                                |

---

## Spec Sections vs Implementation

| Spec Section              | Impl Status | Gap                                                   |
| ------------------------- | ----------- | ----------------------------------------------------- |
| §4 System Architecture    | ✅          | —                                                     |
| §5 Control Plane          | ✅          | —                                                     |
| §6 Job State Machine      | ✅          | Chat creates jobs; agents can't create sub-jobs yet   |
| §7 Agent Registry         | ✅          | —                                                     |
| §8 Memory System          | ✅          | Tools + extraction wired; needs real-world data       |
| §9 Approval Gates         | 🔧          | Config-based gate works; agents can't self-initiate   |
| §10 Session Buffer        | ✅          | `session_message` table + JSONL buffer writer         |
| §11 Orchestration         | ✅          | Graphile Worker operational                           |
| §12 Agent Lifecycle       | ✅          | —                                                     |
| §13 Security Model        | 🔧          | Auth done, pod security not tested                    |
| §14 Browser Orchestration | 🔧          | APIs built, no agent→browser trigger                  |
| §15 Channel Integration   | ✅          | Adapters wired at runtime, binding live               |
| §16 Voice Integration     | ❌          | Signaling routes exist, no implementation             |
| §17 Memory Extraction     | ✅          | Pipeline wired to execution stream                    |
| §18 PostgreSQL            | ✅          | CNPG single-node                                      |
| §19 Observability         | 🔧          | Pino logging, OTel config exists                      |
| §20 LLM Failover          | ✅          | Error classification + circuit breaker + provider router |
| §21 Skills Framework      | ❌          | Not started                                           |
| §22 Dashboard             | ✅          | All screens built + empty states                      |
| §23 Infrastructure        | ✅          | k3s + CI/CD + Tailscale                               |
