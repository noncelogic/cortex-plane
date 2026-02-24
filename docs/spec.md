# Cortex Plane — Architecture Specification

**Version:** 1.0.0  
**Date:** 2026-02-24  
**Status:** Draft  
**Authors:** Joe Graham, Hessian (⚡)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Design Principles](#3-design-principles)
4. [System Architecture](#4-system-architecture)
5. [Control Plane](#5-control-plane)
6. [Job State Machine](#6-job-state-machine)
7. [Agent Registry & Session Mapping](#7-agent-registry--session-mapping)
8. [Memory System](#8-memory-system)
9. [Checkpoint & Approval Gates](#9-checkpoint--approval-gates)
10. [Session Buffer (JSONL)](#10-session-buffer-jsonl)
11. [Orchestration (Graphile Worker)](#11-orchestration-graphile-worker)
12. [Agent Lifecycle](#12-agent-lifecycle)
13. [Security Model](#13-security-model)
14. [Browser Orchestration](#14-browser-orchestration)
15. [Channel Integration](#15-channel-integration)
16. [Voice Integration](#16-voice-integration)
17. [Infrastructure & Deployment](#17-infrastructure--deployment)
18. [Migration Path](#18-migration-path)
19. [Risk Assessment](#19-risk-assessment)
20. [Appendices](#appendices)

---

## 1. Executive Summary

Cortex Plane is an autonomous agent orchestration platform that replaces the monolithic OpenClaw architecture with a cloud-native, self-healing system. It deploys per-agent containers on a k3s cluster, orchestrates durable workflows through PostgreSQL and Graphile Worker, and maintains agent memory through a three-tiered system backed by Qdrant.

The platform acts as a **control plane** — the persistent brain and orchestrator — while pluggable coding models (Claude Code, Codex) serve as ephemeral **execution backends**. Agents are first-class Kubernetes workloads with strict security isolation, automatic recovery from crashes, and human-in-the-loop approval gates for high-risk operations.

### Key Properties

- **Orchestration, not execution.** The control plane dispatches work; it does not run LLM inference.
- **Memory is the moat.** A three-tiered memory system (working memory → session buffer → Qdrant) survives context compaction, pod crashes, and node failures.
- **Blast radius containment.** Each agent runs in an isolated pod with dropped capabilities, per-agent RBAC, and strict network policies.
- **Durable execution.** PostgreSQL-backed state machine with Graphile Worker guarantees exactly-once job execution with automatic retries and exponential backoff.
- **Human oversight.** Approval gates pause execution for high-risk operations; humans approve via API, dashboard, or Telegram inline buttons.

---

## 2. Problem Statement

### 2.1 Architectural Deficiencies in OpenClaw

The current baseline infrastructure (OpenClaw) operates as a monolithic Node.js Gateway process that simultaneously handles session state, message routing, tool execution, and security enforcement. Analysis of production deployments reveals three categories of structural failure:

**Process Monolith & Security Vulnerabilities.** All agents and tools operate within a single shared runtime. A prompt injection during browser automation could theoretically access credentials and execution privileges of all other tools across the entire host. Custom overlay patches (exec denylists, tool allowlists) are band-aids, not cures.

**Brittle Pipeline States.** Event-driven pipelines rely on local `pipeline-state.json` with a WIP limit of one. Network operations hang indefinitely; the gateway detects "stuck sessions" after 120 seconds but lacks automated hard-timeout recovery. Telegram long-polling connections silently die, disconnecting the agent from the user.

**Context Compaction Infinite Loops.** When the LLM context window fills, compaction flushes memory. If workspace files are truncated during compaction, the agent recreates them, instantly refilling the context and triggering another compaction. The system traps itself in an irrecoverable loop, destroying long-term utility.

### 2.2 Target State

The platform must achieve:

1. **Per-agent isolation** in dedicated containers with independent failure domains.
2. **Durable execution** that survives pod crashes, node failures, and gateway restarts.
3. **Memory persistence** that survives context compaction without information loss.
4. **Multi-channel continuity** — start a task on WhatsApp, check status on Telegram, approve a PR on Discord.
5. **Real-time collaborative steering** — humans observe and redirect agent execution mid-flight.
6. **Proactive scheduling** — agents execute on cron-like cadences without waiting for user prompts.

---

## 3. Design Principles

1. **PostgreSQL is the source of truth.** All authoritative state lives in PostgreSQL. Everything else (JSONL buffers, Qdrant vectors, markdown files) is derived or supplementary.
2. **Fail explicit, not silent.** Agents articulate failure points and propose alternatives rather than hallucinating success.
3. **Defense in depth.** Security is layered: database-level transition validation, per-agent RBAC, dropped capabilities, network policies, approval gates.
4. **Simple until proven insufficient.** Single-node Qdrant before clustering. Raw Kustomize before Helm. Monorepo before distributed packages.
5. **Human wins.** When human and agent edits conflict, the human's version is authoritative. Always.

---

## 4. System Architecture

### 4.1 Component Topology

```
┌─────────────────────────────────────────────────────┐
│                    k3s Cluster                       │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │           Control Plane (Stateless)           │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │   │
│  │  │ Fastify  │  │ Graphile │  │  Channel   │  │   │
│  │  │   API    │  │  Worker  │  │  Adapters  │  │   │
│  │  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │   │
│  │       │              │              │         │   │
│  │       └──────┬───────┴──────────────┘         │   │
│  │              │                                │   │
│  │              ▼                                │   │
│  │     ┌────────────────┐                        │   │
│  │     │  PostgreSQL    │                        │   │
│  │     │  (State, Jobs, │                        │   │
│  │     │   Registry)    │                        │   │
│  │     └────────────────┘                        │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │  Agent Pod  │  │  Agent Pod  │  │   Qdrant   │  │
│  │  ┌───────┐  │  │  ┌───────┐  │  │  (Memory)  │  │
│  │  │ Core  │  │  │  │ Core  │  │  │            │  │
│  │  │ Agent │  │  │  │ Agent │  │  └────────────┘  │
│  │  ├───────┤  │  │  ├───────┤  │                   │
│  │  │Playw- │  │  │  │Playw- │  │                   │
│  │  │right  │  │  │  │right  │  │                   │
│  │  │Sidecar│  │  │  │Sidecar│  │                   │
│  │  └───────┘  │  │  └───────┘  │                   │
│  │  SubPath PVC│  │  SubPath PVC│                   │
│  └─────────────┘  └─────────────┘                   │
└─────────────────────────────────────────────────────┘
```

### 4.2 Technology Stack

| Layer                | Technology                                     | Rationale                                                                            |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Infrastructure**   | k3s on Proxmox                                 | Per-agent container isolation. Portability layer for future cloud scaling (EKS/GKE). |
| **Runtime**          | Node.js 24 LTS (Krypton), TypeScript, ESM-only | Native async/await, ecosystem compatibility, strict typing.                          |
| **HTTP Framework**   | Fastify                                        | Native Node.js, Pino logging, plugin encapsulation.                                  |
| **Orchestration**    | PostgreSQL + Graphile Worker                   | Durable workflows, automatic retries, checkpointing. Replaces JSON state files.      |
| **ORM**              | Kysely                                         | Type-safe SQL builder. No conflict with Graphile Worker's self-managed schema.       |
| **Active Memory**    | Session JSONL Buffer                           | Durable event log for diagnostics and crash recovery. Supplementary to PostgreSQL.   |
| **Long-Term Memory** | Qdrant                                         | Unbounded JSON metadata payloads, per-type decay half-lives, scalar quantization.    |
| **Browser**          | Playwright (k8s sidecar)                       | Containerized headless browser for visual DOM observation.                           |
| **Build**            | pnpm Workspaces + Turborepo                    | Monorepo with package isolation.                                                     |
| **Test**             | Vitest                                         | Fast, ESM-native, watch mode.                                                        |
| **Docker Base**      | node:24-slim                                   | glibc compat, Playwright support, ARM64.                                             |

### 4.3 Monorepo Structure

```
cortex-plane/
├── packages/
│   ├── control-plane/       # Fastify API, Graphile Worker, K8s client
│   ├── shared/              # Types, schemas, utilities
│   ├── dashboard/           # Next.js management UI
│   ├── adapter-telegram/    # Telegram channel adapter
│   └── adapter-discord/     # Discord channel adapter
├── deploy/
│   ├── k8s/                 # Kustomize manifests
│   └── docker/              # Dockerfiles
├── docs/
│   ├── spec.md              # This document
│   └── spikes/              # Design spike outputs
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

TypeScript configuration: strict mode, ESM-only (`nodenext` module resolution), `verbatimModuleSyntax`, project references across packages.

---

## 5. Control Plane

The control plane is the stateless orchestrator. It manages the job queue, dispatches work to agent pods, handles channel routing, and serves the management API.

### 5.1 Statelessness

All queue and session state is backed by PostgreSQL. The control plane process holds no critical state in memory. This enables:

- **Horizontal scaling:** 2+ replicas behind a load balancer.
- **Zero-downtime deploys:** Rolling updates don't drop active sessions.
- **Node failure resilience:** Any replica can serve any request.

### 5.2 Hot Reload

Configuration changes, skill updates, and channel adapter credentials reload dynamically without restarting the process. This prevents dropping active WebSocket/SSE connections — a major flaw in OpenClaw's legacy gateway.

### 5.3 Graceful Shutdown

Using Graphile Worker's `.gracefulShutdown()` pattern:

1. Stop accepting new jobs.
2. Wait for active agents to finish their current LLM response.
3. Flush state to JSONL buffer.
4. Terminate.

The `terminationGracePeriodSeconds` is set to 65 seconds (5s preStop hook + 60s drain). LLM calls longer than 60 seconds are aborted; the agent resumes from the last checkpoint on the new pod. The cost is one wasted API call — acceptable.

### 5.4 REST API

```yaml
paths:
  /agents:
    get:
      summary: List all active agents and their statuses
  /agents/{agentId}/steer:
    post:
      summary: Inject mid-execution steering instructions
  /agents/{agentId}/pause:
    post:
      summary: Force graceful pause, writing state to checkpoint
  /memory/sync:
    post:
      summary: Trigger bidirectional markdown ↔ Qdrant sync
  /voice/webrtc-offer:
    post:
      summary: Exchange SDP payload for Voice AI session
  /jobs/{jobId}/approve:
    post:
      summary: Un-pause a job waiting at a human approval gate
```

---

## 6. Job State Machine

> **Spike Reference:** [024-job-state-machine.md](spikes/024-job-state-machine.md)

### 6.1 States

```
PENDING → SCHEDULED → RUNNING → WAITING_FOR_APPROVAL → COMPLETED
                         │              │                    │
                         ▼              ▼                    │
                       FAILED ←── TIMED_OUT                  │
                         │                                   │
                         ▼                                   │
                      RETRYING ──────────────────────────────┘
                         │
                         ▼
                   DEAD_LETTER
```

| State                  | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `PENDING`              | Job created, not yet eligible for scheduling.        |
| `SCHEDULED`            | Eligible for pickup by Graphile Worker.              |
| `RUNNING`              | Agent is actively executing.                         |
| `WAITING_FOR_APPROVAL` | Paused at a human approval gate.                     |
| `COMPLETED`            | Successfully finished.                               |
| `FAILED`               | Execution failed; may be retried.                    |
| `TIMED_OUT`            | Exceeded maximum execution duration.                 |
| `RETRYING`             | Failed, queued for retry with backoff.               |
| `DEAD_LETTER`          | Exhausted all retries; requires manual intervention. |

### 6.2 Database Schema

```sql
CREATE TYPE job_status AS ENUM (
  'PENDING', 'SCHEDULED', 'RUNNING',
  'WAITING_FOR_APPROVAL', 'COMPLETED',
  'FAILED', 'TIMED_OUT', 'RETRYING', 'DEAD_LETTER'
);

CREATE TABLE job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agent(id),
  session_id      UUID REFERENCES session(id),
  status          job_status NOT NULL DEFAULT 'PENDING',
  priority        INTEGER NOT NULL DEFAULT 0,
  payload         JSONB NOT NULL,
  result          JSONB,
  checkpoint      JSONB,
  checkpoint_crc  INTEGER,
  error           JSONB,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ
);
```

### 6.3 Transition Validation

State transitions are enforced by a `BEFORE UPDATE` trigger — defense in depth. Even if application code has a bug, the database rejects invalid transitions:

```sql
CREATE FUNCTION validate_job_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NOT (
    (OLD.status = 'PENDING'    AND NEW.status IN ('SCHEDULED', 'FAILED')) OR
    (OLD.status = 'SCHEDULED'  AND NEW.status IN ('RUNNING', 'FAILED')) OR
    (OLD.status = 'RUNNING'    AND NEW.status IN ('COMPLETED', 'FAILED',
                                                   'TIMED_OUT', 'WAITING_FOR_APPROVAL')) OR
    (OLD.status = 'WAITING_FOR_APPROVAL' AND NEW.status IN ('RUNNING', 'FAILED', 'TIMED_OUT')) OR
    (OLD.status = 'FAILED'     AND NEW.status IN ('RETRYING', 'DEAD_LETTER')) OR
    (OLD.status = 'TIMED_OUT'  AND NEW.status IN ('RETRYING', 'DEAD_LETTER')) OR
    (OLD.status = 'RETRYING'   AND NEW.status IN ('SCHEDULED', 'DEAD_LETTER'))
  ) THEN
    RAISE EXCEPTION 'Invalid job transition: % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 6.4 Key Decisions

- **UUIDv7** for primary keys — chronologically sortable, no sequence contention.
- **PostgreSQL ENUM** for status — 4-byte OIDs, explicit error messages.
- **Trigger-based validation** — one place for transition rules, fires within the same transaction.

---

## 7. Agent Registry & Session Mapping

> **Spike Reference:** [025-agent-registry-session-mapping.md](spikes/025-agent-registry-session-mapping.md)

### 7.1 Agent Definition

An agent is a reusable definition with identity, classification, configuration, constraints, and lifecycle:

```sql
CREATE TABLE agent (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  slug            TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL,
  description     TEXT,
  model_config    JSONB NOT NULL DEFAULT '{}',
  skill_config    JSONB NOT NULL DEFAULT '{}',
  resource_limits JSONB NOT NULL DEFAULT '{}',
  channel_permissions JSONB NOT NULL DEFAULT '{}',
  status          agent_status NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE agent_status AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');
```

- **Role is free-text**, not an enum. Roles evolve rapidly; DDL changes are unnecessary friction.
- **JSONB for configuration.** Model config, skill config, and resource limits are structured data with schemas that evolve per agent type.
- **DISABLED** preserves the definition but blocks new sessions. **ARCHIVED** hides from UI while preserving historical references.

### 7.2 Unified User Identity

Two-table design separating internal identity from platform-specific identifiers:

```sql
CREATE TABLE user_account (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_mapping (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID NOT NULL REFERENCES user_account(id),
  channel_type    TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_type, channel_user_id)
);
```

Adding a new channel means adding rows, not columns. Alice can link Telegram, Discord, and WhatsApp to the same `user_account`. All sessions and jobs are attributed to `user_account`, not any channel-specific identity.

### 7.3 Cross-Channel Session Continuity

Sessions reference `user_account_id`. Any channel adapter that resolves to the same `user_account` reaches the same session. Start a task on WhatsApp, check status on Telegram, approve a PR on Discord — same agent, same memory, same context.

---

## 8. Memory System

The memory system is the core differentiator. It implements a three-tiered architecture designed to survive context compaction, pod crashes, and node failures.

### 8.1 Three Tiers

| Tier                     | Store              | Purpose                               | Durability                       |
| ------------------------ | ------------------ | ------------------------------------- | -------------------------------- |
| **1 — Working Memory**   | LLM context window | Active reasoning                      | Ephemeral (lost on compaction)   |
| **2 — Session Buffer**   | JSONL files on PVC | Crash recovery, diagnostics           | Durable (survives pod restart)   |
| **3 — Long-Term Memory** | Qdrant             | Persistent knowledge, semantic search | Persistent (survives everything) |

### 8.2 Qdrant Schema

> **Spike Reference:** [029-qdrant-schema.md](spikes/029-qdrant-schema.md)

**Collection:** One per agent (e.g., `memories_devops_01`).

**Vector:** 1536 dimensions (`text-embedding-3-small`), cosine distance, scalar int8 quantization from day one.

```typescript
interface MemoryRecord {
  id: string // UUIDv7 (agent-created) or UUIDv5 (markdown-synced)
  vector: number[] // 1536-dim embedding
  payload: {
    type: "fact" | "task" | "emotional" | "episodic"
    content: string
    source: string // 'session_45', 'MEMORY.md', 'markdown_sync'
    createdAt: number
    accessCount: number
    lastAccessedAt: number
    tags: string[]
    people: string[]
    projects: string[]
    supersedesId?: string // Memory evolution chain
  }
}
```

**Decay Algorithm:**

```typescript
function calculateDecayScore(record: MemoryRecord, similarity: number): number {
  const halfLives = { fact: 365, task: 30, emotional: 60, episodic: 14 }
  const daysOld = (Date.now() - record.payload.createdAt) / 86400000
  const recencyScore = Math.pow(2, -(daysOld / halfLives[record.payload.type]))
  const utilityScore = Math.log10(record.payload.accessCount + 1)

  return 0.5 * similarity + 0.3 * recencyScore + 0.2 * utilityScore
}
```

**Key decisions:**

- Cosine distance (not dot product) — works correctly even with non-normalized vectors.
- Scalar int8 quantization from day one — 4× memory reduction, negligible accuracy loss at 100K scale.
- UUIDv7 point IDs for agent-created memories (time-ordered); UUIDv5 for markdown-synced memories (idempotent).
- Access count updates are fire-and-forget — utility signal, not correctness requirement.

### 8.3 Qdrant Deployment

> **Spike Reference:** [030-qdrant-deployment.md](spikes/030-qdrant-deployment.md)

**Topology:** Single-node, no clustering. 100K vectors at 1536 dimensions with int8 quantization = ~210 MB total. Clustering is unnecessary complexity at this scale.

**Resources:**

- Requests: 500m CPU, 1Gi RAM
- Limits: 1000m CPU, 2Gi RAM
- PVC: 10Gi (local-path provisioner), `ReadWriteOnce`

**Deployment:** Raw Kustomize manifests (not Helm). Four files, fully readable and auditable.

**Backup:** Qdrant snapshot API on a daily cron, retained for 7 days. Not WAL replay — Qdrant's WAL is an internal detail, not a backup mechanism.

**Security:** Read-only root filesystem, non-root user (UID 1000), dropped ALL capabilities.

### 8.4 Markdown ↔ Qdrant Sync

> **Spike Reference:** [032-memory-sync.md](spikes/032-memory-sync.md)

**Direction:** Unidirectional (file → Qdrant). The file is authoritative. Qdrant is a derived semantic index.

**Chunking:** Structure-aware, parsing markdown headers (`##`) to preserve semantic hierarchy. Not arbitrary character splits.

**Change Detection:** File watcher (chokidar) with 2-second debounce. Content hashing (SHA-256 of chunk text) for deduplication.

**Deletion Propagation:** If a user deletes a section from MEMORY.md, the file watcher detects the missing hash and propagates a DELETE to the corresponding Qdrant point ID.

**"Human Wins" Lock:** If the file watcher detects a human save while the agent is writing, the agent's write is intercepted. The human's filesystem diff is the absolute ground truth.

**Deterministic IDs:** Markdown-sourced memories use UUIDv5 (name-based, deterministic) for idempotent upserts. If the sync crashes and restarts, re-processing produces the same point IDs — upserts, not duplicates.

---

## 9. Checkpoint & Approval Gates

> **Spike Reference:** [026-checkpoint-approval-schema.md](spikes/026-checkpoint-approval-schema.md)

### 9.1 Checkpointing

**Strategy:** Full snapshot. Each checkpoint contains the complete state.

- Resume reads one checkpoint — no delta chain replay.
- Corruption is isolated to one checkpoint; previous state is preserved.
- Size is 10-100 KB per checkpoint. Write overhead is negligible.

**Integrity:** CRC-32 (not SHA-256). Checkpoints are written and read within a secured PostgreSQL database — no adversarial threat model. CRC-32 is 6× faster and produces a compact integer.

### 9.2 Approval Gates

When an agent attempts a high-risk action (e.g., `git push --force`, production deployment, sending external emails):

1. The worker updates job state to `WAITING_FOR_APPROVAL`.
2. A notification is sent via the user's preferred channel (Telegram inline button, dashboard, API).
3. Execution pauses. No tokens are burned while waiting.
4. The human approves via `/jobs/{jobId}/approve` endpoint.
5. The worker resumes from the exact checkpoint.

**Security:** Approval tokens are SHA-256 hashed before storage. Plaintext is sent only in notifications. If the database is compromised, the attacker gets hashes, not tokens.

**Expiry:** Approval requests expire after a configurable TTL (default: 24 hours). Expired requests transition the job to `TIMED_OUT`.

### 9.3 Approval Request Schema

```sql
CREATE TABLE approval_request (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES job(id),
  action_type     TEXT NOT NULL,
  action_detail   JSONB NOT NULL,
  token_hash      TEXT NOT NULL,
  status          approval_status NOT NULL DEFAULT 'PENDING',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  decided_by      UUID REFERENCES user_account(id),
  expires_at      TIMESTAMPTZ NOT NULL,
  decision_note   TEXT
);

CREATE TYPE approval_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
```

---

## 10. Session Buffer (JSONL)

> **Spike Reference:** [031-jsonl-buffer.md](spikes/031-jsonl-buffer.md)

### 10.1 Role

The JSONL buffer is **supplementary**, not authoritative. PostgreSQL is the source of truth. If the buffer is lost, the system still works — losing it degrades diagnostics, not correctness.

### 10.2 Content

The buffer stores **events** (things that happened), not snapshots (state at a point in time):

- Events are compact (~500 bytes per tool result vs ~50 KB per snapshot).
- Events capture causality: "LLM said use tool X, tool X returned Y, then LLM said use tool Z."
- The PostgreSQL checkpoint already provides the snapshot.

### 10.3 Event Schema

```typescript
interface BufferEvent {
  version: "1.0"
  timestamp: string // ISO 8601
  jobId: string
  sessionId: string
  agentId: string
  sequence: number // Monotonic within session
  type:
    | "LLM_REQUEST"
    | "LLM_RESPONSE"
    | "TOOL_CALL"
    | "TOOL_RESULT"
    | "CHECKPOINT"
    | "ERROR"
    | "STEERING"
    | "APPROVAL_REQUEST"
    | "APPROVAL_DECISION"
    | "SESSION_START"
    | "SESSION_END"
  data: Record<string, unknown>
  crc32?: number // Optional integrity check
}
```

### 10.4 File Layout

```
/data/sessions/
└── <job_id>/
    ├── session-001.jsonl
    ├── session-002.jsonl    # After crash/recovery
    └── metadata.json        # Job metadata, start time, agent config
```

One directory per job, one file per session attempt. Rotation by session, not by size or time.

### 10.5 Write Protocol

- Append after every LLM response and tool result.
- `fs.appendFileSync()` — synchronous append to guarantee ordering.
- `fsync` after checkpoint events only (not every write). Periodic fsync for non-checkpoint events (configurable, default: 30 seconds).
- Corruption handling: if the last line is truncated (crash mid-write), the recovery process detects the incomplete JSON and discards it.

---

## 11. Orchestration (Graphile Worker)

> **Spike Reference:** [028-graphile-patterns.md](spikes/028-graphile-patterns.md)

### 11.1 Error Classification

All errors from all sources (HTTP, Node.js, LLM SDK, tool outputs) are classified into five categories:

| Classification | Action                         | Example                                       |
| -------------- | ------------------------------ | --------------------------------------------- |
| `TRANSIENT`    | Retry with exponential backoff | HTTP 429, 502, 503; ECONNRESET                |
| `PERMANENT`    | Fail immediately, no retry     | HTTP 400, 401, 404; schema validation failure |
| `TIMEOUT`      | Retry with increased timeout   | LLM call exceeds 120s                         |
| `RESOURCE`     | Retry after cooldown           | OOM, disk full, rate limit                    |
| `UNKNOWN`      | Retry once, then fail          | Unclassified errors                           |

### 11.2 Retry Strategy

```typescript
const retryConfig = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 300000, // 5 minutes
  backoffMultiplier: 2,
  jitter: true, // ±25% randomization
}

function calculateDelay(attempt: number): number {
  const delay = Math.min(
    retryConfig.baseDelay * Math.pow(retryConfig.backoffMultiplier, attempt),
    retryConfig.maxDelay,
  )
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return delay + jitter
}
```

### 11.3 Heartbeat-Based Zombie Detection

Running jobs emit a heartbeat (`heartbeat_at` timestamp) every 30 seconds. A background reaper queries for jobs where `heartbeat_at < NOW() - INTERVAL '90 seconds'` and transitions them to `FAILED` with error classification `TIMEOUT`.

Why heartbeats over leases: heartbeats are transparent (`SELECT ... WHERE heartbeat_at < threshold`), no lease contention, no deadlock scenarios.

### 11.4 Graceful Shutdown Sequence

```
T+0s   SIGTERM received
T+0s   preStop hook runs (5s) — endpoint removal propagates
T+5s   Worker stops accepting new jobs
T+5s   Active jobs: flush JSONL, write checkpoint, set status='FAILED' with 'GRACEFUL_SHUTDOWN'
T+55s  Process exits
T+65s  SIGKILL (if still alive)
```

---

## 12. Agent Lifecycle

### 12.1 Pod Lifecycle

1. **Boot:** Pod scheduled. Init container pulls agent-specific IDENTITY.md and SKILL.md files from the control plane.
2. **Hydration:** Core agent process starts, queries Qdrant for immediate context, loads the last checkpoint from PostgreSQL.
3. **Ready:** Liveness/readiness probes pass once SSE connection to the control plane is established.
4. **Runtime:** Agent processes tasks. Heartbeats emitted every 30 seconds.
5. **Crash/Recovery:** State is flushed to JSONL after every event and checkpointed to PostgreSQL periodically. A crashed pod is replaced by k8s, re-reads the checkpoint, and resumes from the last known state.

### 12.2 Pod Spec

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: agent-devops-01
spec:
  serviceAccountName: agent-devops-01
  terminationGracePeriodSeconds: 65
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  initContainers:
    - name: hydrate
      image: cortex-plane/agent-init:latest
      # Pulls identity files, skill configs from control plane
  containers:
    - name: core-agent
      image: cortex-plane/agent:latest
      resources:
        requests: { cpu: 500m, memory: 512Mi }
        limits: { cpu: 1000m, memory: 1Gi }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      volumeMounts:
        - name: workspace
          mountPath: /workspace
          subPath: agent-devops-01 # Isolation
    - name: playwright
      image: mcr.microsoft.com/playwright:latest
      resources:
        requests: { cpu: 1000m, memory: 1Gi }
        limits: { cpu: 2000m, memory: 2Gi }
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      ports:
        - containerPort: 9222 # CDP
  volumes:
    - name: workspace
      persistentVolumeClaim:
        claimName: agent-workspace
```

---

## 13. Security Model

### 13.1 Blast Radius Containment

- **Dropped capabilities:** ALL capabilities dropped for all containers. No `NET_BIND_SERVICE`, no `SYS_ADMIN`.
- **Pod Security Standards:** Restricted level.
- **Read-only root filesystem:** Agents write only to `/workspace` (mounted PVC) and `/tmp` (emptyDir).
- **Non-root:** All containers run as UID 1000, fsGroup 2000.
- **Seccomp:** RuntimeDefault profile.

### 13.2 Per-Agent RBAC

Each agent gets a dedicated ServiceAccount with minimal RBAC:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agent-devops-01
  namespace: cortex-plane
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["agent-devops-01-config"]
    verbs: ["get", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["agent-devops-01-secrets"]
    verbs: ["get"]
```

Agents cannot list pods, create deployments, or access other agents' secrets.

### 13.3 Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-isolation
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: agent
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: control-plane
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: control-plane
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: qdrant
    - to: # External API access
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8 # Block cluster-internal
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
          protocol: TCP
```

**Agent-to-agent traffic is blocked.** Agents communicate only through the control plane.

### 13.4 Scoped Secrets

API keys are injected just-in-time via Kubernetes Secrets mounted per-agent. No agent can access another agent's credentials.

---

## 14. Browser Orchestration

### 14.1 Observe-Think-Act Loop

The agent's browser interaction follows a rigorous loop:

1. **Observe:** Playwright navigates to the target URL, captures a screenshot + structural DOM.
2. **Think:** The vision-language model analyzes the screenshot, identifying elements, buttons, and data feeds.
3. **Act:** The model directs Playwright to execute specific click paths, fill forms, or capture targeted screenshots.

### 14.2 User Observes Agent's Browser

- **Live Cursor Replay:** The Playwright sidecar exposes a VNC stream. noVNC embedded in the dashboard provides real-time viewing.
- **Annotation Layer:** Users click on elements in the video feed to generate annotated prompts with bounding box coordinates.
- **Multi-Tab Awareness:** Dashboard queries `browserContext.pages()` to show a tab bar.
- **Audit Recording:** Playwright Trace Viewer captures DOM snapshots, network requests, and console logs — not raw MP4.

### 14.3 User Shares Browser with Agent

- **Authentication Handoff:** User logs in locally. A browser extension extracts session cookies and injects them into the remote Playwright BrowserContext via `addCookies`.
- **Selective Tab Sharing:** WebRTC via `getDisplayMedia({ preferCurrentTab: true })` — the agent sees only the designated tab.
- **Bidirectional Control:** "Let Agent Drive" toggle grants the remote agent permission to dispatch CDP commands through the extension.

### 14.4 Network Resilience

- **Bandwidth Awareness:** If WebSocket latency degrades, graceful fallback from 30fps live video to polling static screenshots every 3 seconds.
- **Mobile Fallback:** Mobile browsers default to "Screenshot + Annotate" mode.
- **Seamless Handoff:** Switching between user-driven and agent-driven swaps an input priority flag — no session teardown.

---

## 15. Channel Integration

### 15.1 Unified Multi-Channel Routing

The API gateway maps incoming platform-specific `chat_id` to a unified `user_account_id` in PostgreSQL. This enables cross-channel session continuity.

### 15.2 Per-Channel Health Probes

The control plane injects synthetic heartbeats into each channel adapter. If a heartbeat goes unacknowledged, the gateway tears down and re-establishes the specific channel adapter without restarting the entire gateway.

### 15.3 Channel Adapter Interface

```typescript
interface ChannelAdapter {
  readonly channelType: string

  start(): Promise<void>
  stop(): Promise<void>
  healthCheck(): Promise<boolean>

  sendMessage(userId: string, content: MessageContent): Promise<void>
  sendApprovalRequest(userId: string, request: ApprovalRequest): Promise<void>

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
}
```

Adapters are npm packages (`@cortex-plane/adapter-telegram`, `@cortex-plane/adapter-discord`). Adding a new channel means implementing the interface and registering the package.

---

## 16. Voice Integration

### 16.1 WebRTC Architecture

- **Protocol:** WebRTC over UDP — adaptive jitter buffering and echo cancellation for sub-500ms voice response times.
- **Signaling:** The API gateway handles the WebRTC signaling handshake, generating ephemeral tokens.
- **STT/TTS Pipeline:** ElevenLabs Conversational AI, deeply hooked into the unified session context.
- **Session Continuity:** Voice sessions share the same agent session and memory context as text channels.

---

## 17. Infrastructure & Deployment

### 17.1 Target Environment

k3s cluster on Proxmox VE, running across homelab hardware:

| Host        | Hardware          | Role                                     |
| ----------- | ----------------- | ---------------------------------------- |
| lnx-aquila  | Ryzen 9 3900XT    | k3s worker, development                  |
| lnx-orion   | Ryzen 9 3950X     | k3s worker                               |
| lnx-pegasus | Proxmox VE server | VM hosting (Qdrant VM, future k3s nodes) |

### 17.2 Resource Budget

| Component                  | CPU         | RAM         | Storage   |
| -------------------------- | ----------- | ----------- | --------- |
| k3s Control Plane          | 2 vCPU      | 4 GB        | —         |
| PostgreSQL                 | 2 vCPU      | 4 GB        | 20 GB     |
| Qdrant                     | 500m–1000m  | 1–2 GB      | 10 GB PVC |
| Per-Agent Pod (core)       | 500m–1000m  | 512 Mi–1 Gi | —         |
| Per-Agent Pod (Playwright) | 1000m–2000m | 1–2 Gi      | —         |

At 1536 dimensions with int8 quantization, 100K vectors consume ~210 MB of RAM in Qdrant. The 2 GB limit provides massive headroom.

### 17.3 Cost Model

Infrastructure is self-hosted (zero cloud compute cost). Operational costs shift to API usage:

| Service                             | Cost                   | Usage                |
| ----------------------------------- | ---------------------- | -------------------- |
| LLM extraction (memory compaction)  | ~$0.25/1M input tokens | ~1-2 compactions/day |
| Embeddings (text-embedding-3-small) | $0.02/1M tokens        | Daily markdown sync  |
| LLM inference (Claude Opus, Gemini) | Variable               | Per-job execution    |

---

## 18. Migration Path

### Phase 1: Dual-Brain Integration (Weeks 1-2)

- Keep existing OpenClaw gateway running.
- Deploy PostgreSQL + Qdrant on k3s.
- Modify OpenClaw's compaction hook to write to Qdrant — test extraction logic in production.

### Phase 2: Strangler Fig (Weeks 3-4)

- Deploy the new k3s control plane.
- Migrate passive scheduled tasks (janitor crons) from OpenClaw to containerized agents.
- Leave primary orchestration on OpenClaw for PR creation.

### Phase 3: Full Cutover (Weeks 5-6)

- Migrate Telegram/Discord webhooks to the new control plane.
- Shutdown OpenClaw systemd services.
- Repurpose bare-metal hosts as k3s worker nodes.

---

## 19. Risk Assessment

| Risk                             | Impact                        | Probability | Mitigation                                                                                                         |
| -------------------------------- | ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| **Vector indexing latency**      | High — stalls agent execution | Low         | Extraction/indexing runs asynchronously via background workers. Agents never wait for Qdrant writes.               |
| **Playwright OOM**               | Medium — kills pod            | Medium      | Strict k8s limits (2Gi). Agent catches connection drops and restarts DOM observation.                              |
| **Compaction loop relapse**      | High — infinite token burn    | Low         | Hard limit of 3 retries on file-creation failures. Agent falls back to `ask: always` requiring human intervention. |
| **PostgreSQL failure**           | Critical — all state lost     | Very Low    | WAL archiving, daily pg_dump, PVC snapshots.                                                                       |
| **Qdrant data loss**             | Medium — memory degradation   | Low         | Daily snapshot backups, 7-day retention. Markdown files are authoritative source.                                  |
| **Channel adapter silent death** | Medium — user disconnect      | Medium      | Per-channel synthetic heartbeats with automatic adapter restart.                                                   |
| **LLM API outage**               | High — all agents stall       | Low         | Multi-provider failover (Claude → Gemini → GPT). Graceful degradation to `WAITING_FOR_APPROVAL`.                   |

---

## Appendices

### A. Spike Index

| #   | Title                                | Status         | Spike Document                                                                        |
| --- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------- |
| 24  | Job State Machine Schema             | ✅ Merged      | [024-job-state-machine.md](spikes/024-job-state-machine.md)                           |
| 25  | Agent Registry & Session Mapping     | ✅ Merged      | [025-agent-registry-session-mapping.md](spikes/025-agent-registry-session-mapping.md) |
| 26  | Checkpoint & Approval Schema         | ✅ Merged      | [026-checkpoint-approval-schema.md](spikes/026-checkpoint-approval-schema.md)         |
| 27  | Project Structure & Tooling          | ✅ Merged      | [027-project-structure.md](spikes/027-project-structure.md)                           |
| 28  | Graphile Retry, Timeout & Shutdown   | ✅ Merged      | [028-graphile-patterns.md](spikes/028-graphile-patterns.md)                           |
| 29  | Qdrant Collection Schema & Decay     | ✅ Merged      | [029-qdrant-schema.md](spikes/029-qdrant-schema.md)                                   |
| 30  | Qdrant Deployment Topology           | ✅ Merged      | [030-qdrant-deployment.md](spikes/030-qdrant-deployment.md)                           |
| 31  | JSONL Session Buffer & Recovery      | ✅ Merged      | [031-jsonl-buffer.md](spikes/031-jsonl-buffer.md)                                     |
| 32  | Memory Sync: Markdown Chunking       | ✅ Merged      | [032-memory-sync.md](spikes/032-memory-sync.md)                                       |
| 33  | Agent Pods: Security Model           | 🔄 In Progress | —                                                                                     |
| 34  | Agent Lifecycle State Machine        | Pending        | —                                                                                     |
| 35  | Playwright Observe-Think-Act Loop    | Pending        | —                                                                                     |
| 36  | Approval Gates UX & Integration      | Pending        | —                                                                                     |
| 37  | Execution Backends Adapter Interface | Pending        | —                                                                                     |

### B. References

1. OpenClaw Architecture — Noncelogic Infrastructure (production deployment analysis)
2. [Inside OpenClaw: How a Persistent AI Agent Actually Works](https://dev.to/entelligenceai/inside-openclaw-how-a-persistent-ai-agent-actually-works-1mnk) — DEV Community
3. [Why I Ditched OpenClaw](https://coder.com/blog/why-i-ditched-openclaw-and-built-a-more-secure-ai-agent-on-blink-mac-mini) — Coder
4. [Agent Skills](https://developers.openai.com/codex/skills/) — OpenAI
5. [Adaptive: Building Self-Healing AI Agents](https://medium.com/@madhur.prashant7/evolve-building-self-healing-ai-agents-a-multi-agent-system-for-continuous-optimization-0d711ead090c) — Medium
6. [Architecture strategies for self-healing](https://learn.microsoft.com/en-us/azure/well-architected/reliability/self-preservation) — Microsoft Azure
7. [AI Agent Architecture: Build Systems That Work in 2026](https://redis.io/en/blog/ai-agent-architecture/) — Redis

### C. Glossary

| Term                  | Definition                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------- |
| **Control Plane**     | The stateless orchestrator that manages jobs, agents, and channels.                      |
| **Data Plane**        | The agent pods that execute work.                                                        |
| **Execution Backend** | A pluggable coding model (Claude Code, Codex) that the control plane dispatches work to. |
| **Approval Gate**     | A checkpoint where execution pauses for human review.                                    |
| **Decay Score**       | A composite score combining semantic similarity, recency, and utility to rank memories.  |
| **Session Buffer**    | The JSONL event log that supplements PostgreSQL checkpoints.                             |
| **Strangler Fig**     | Migration pattern where the new system gradually replaces the old one.                   |
