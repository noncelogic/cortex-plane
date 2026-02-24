# Gemini Deep Research Prompt — Cortex Plane Gap Analysis

## Context

You previously produced the attached architecture document for Cortex Plane, an autonomous agent orchestration platform replacing OpenClaw. Since then, we've completed 11 design spikes covering the core subsystems (job state machine, agent registry, checkpointing, Graphile Worker patterns, Qdrant schema/deployment, JSONL session buffer, markdown↔Qdrant sync, pod security, agent lifecycle). The repo is at github.com/noncelogic/cortex-plane with a full spec at docs/spec.md.

We're now starting implementation. The following subsystems were described in the architecture document but lack the implementation-ready depth of the completed spikes. For each gap below, produce a focused deep dive with concrete recommendations, schemas, and trade-off analysis. Frame everything as recommendations — we'll adapt based on shipping expediency and deployment complexity for a homelab k3s environment.

## Gap 1: LLM Memory Extraction Pipeline

The architecture describes "an LLM extracts highly structured atomic facts" for Tier 3 memory, but the mechanics are unspecified.

**Questions:**

1. What triggers extraction? Session end? Context compaction? Every N messages? Configurable?
2. What's the extraction prompt? Produce a production-ready prompt template that outputs structured JSON matching our MemoryRecord schema (type, content, tags, people, projects, importance, supersedesId).
3. Which model should run extraction? The primary reasoning model (expensive) or a cheaper model (Claude Haiku, GPT-4o-mini)? Cost/quality trade-off analysis.
4. How do we validate extraction quality? What does a bad extraction look like, and how do we catch it?
5. Deduplication: cosine similarity threshold for "this memory already exists"? The architecture mentions 0.92 — is that right? How do we handle near-duplicates that add nuance?
6. Supersession chains: when a new fact contradicts an old one, how does the extraction prompt detect and mark `supersedesId`?
7. Batch vs streaming: extract memories one at a time as they occur, or batch at session end?
8. Token budget: how many tokens does extraction cost per session? Model the cost for a typical 50-message session.

## Gap 2: PostgreSQL Deployment on k3s

We have detailed Qdrant deployment specs (spike #30) but nothing equivalent for PostgreSQL, which is the authoritative state store.

**Questions:**

1. Single instance vs HA (Patroni, CloudNativePG operator)? For a homelab with 1-5 agents, is HA overkill?
2. Connection pooling: PgBouncer as sidecar, or rely on Graphile Worker's built-in pool?
3. WAL archiving and PITR: what's the simplest backup strategy that gives us point-in-time recovery? Local WAL archive + daily pg_dump, or something more sophisticated?
4. Resource sizing: CPU, RAM, storage for 1-5 agents with Graphile Worker job throughput?
5. Storage class: local-path provisioner (like Qdrant) or something with replication?
6. TLS for internal connections: required or unnecessary complexity for a homelab cluster?
7. Schema migration tooling: raw SQL files, Kysely migrations, or a dedicated tool (dbmate, golang-migrate)?
8. Monitoring: which pg_stat views to expose via Prometheus? Connection pool saturation, replication lag, table bloat?

## Gap 3: Observability & Telemetry

The architecture references OpenTelemetry, Langfuse, and an "Insights Agent" but provides no implementation detail.

**Questions:**

1. What do we instrument? Every LLM call? Every tool invocation? Every state transition? What's the minimum viable telemetry?
2. OpenTelemetry vs application-level logging: for a homelab, is OTel infrastructure (collector, Jaeger/Tempo) worth the overhead, or is structured Pino logging + Grafana Loki sufficient?
3. LLM-specific metrics: tokens in/out, latency p50/p95/p99, error rate by provider, cost per job. How to capture and expose these?
4. The "Insights Agent" concept: is this practical at homelab scale, or is a Grafana dashboard with alerts more pragmatic? If we keep it, what does its prompt look like?
5. Trace correlation: how do we link a user's Telegram message → channel adapter → job creation → agent execution → tool calls into a single trace?
6. Storage: how long do we retain traces/logs? What's the storage cost?
7. Alerting: what conditions should page the human? Agent stuck > 10 min? Error rate > 50%? Memory extraction failure?

## Gap 4: Multi-Provider LLM Failover

The risk assessment mentions Claude → Gemini → GPT failover but no spike designs it.

**Questions:**

1. Health check: how do we detect a provider is down? Failed requests? Latency spike? HTTP status codes?
2. Failover strategy: automatic circuit breaker, or manual switchover? If automatic, what are the thresholds (N failures in M seconds)?
3. Model capability mapping: not all models are equal. If Claude Opus is down and we fall back to Gemini Flash, some tasks may not work. How do we model capability tiers?
4. Cost awareness: should the failover system prefer cheaper models when the primary is available, or always use the configured model?
5. Sticky sessions: if an agent starts a job on Claude, should it stay on Claude for the duration (consistency), or can it switch mid-job (resilience)?
6. Credential rotation: API keys expire or get revoked. How does the system detect and handle credential failure vs provider outage?
7. Rate limit awareness: different providers have different rate limits. How do we track and respect them?

## Gap 5: Skills Framework in Containerized Agents

OpenClaw loads skills from the local filesystem. In k3s pods, skills need a different loading mechanism.

**Questions:**

1. How are skills delivered to agent pods? Baked into the container image? Mounted via ConfigMap/PVC? Pulled at runtime from a registry?
2. Progressive disclosure in containers: the agent scans skill metadata, then loads full SKILL.md on demand. Where does the metadata index live?
3. Skill dependencies: if Skill A requires Skill B's helper scripts, how is that resolved in a container?
4. Hot-reload: can skills be updated without restarting the agent pod?
5. The "Skill Creator" meta-skill: how does an agent create new skills inside a container with a read-only root filesystem?
6. Skill versioning: how do we handle breaking changes in a skill's interface?
7. Security: can a malicious skill escalate privileges or exfiltrate data? What's the sandbox model?

## Gap 6: Dashboard & Real-Time UI

The architecture specifies a Next.js dashboard with SSE streaming, but no spike covers it.

**Questions:**

1. SSE vs WebSocket: for real-time agent status updates, which is simpler and more reliable?
2. Event schema: what events does the dashboard subscribe to? Agent status changes, job progress, approval requests, log streams?
3. Authentication: how does the dashboard authenticate? JWT? Session cookies? OAuth?
4. Mobile-first or desktop-first? What's the minimum viable dashboard for a single operator?
5. Approval workflow in UI: inline approve/reject buttons, or a dedicated approval queue page?
6. Agent log streaming: how much of the JSONL buffer do we stream to the UI in real-time?
7. noVNC integration: is embedding noVNC for browser observation practical, or should we start with screenshot polling?
8. Can we skip the dashboard entirely for MVP and use Telegram inline buttons + CLI?

## Output Format

For each gap, produce:

1. **Recommendation** — the concrete approach you'd take, with reasoning
2. **Schema/Config** — any TypeScript interfaces, SQL schemas, YAML configs, or prompt templates
3. **Trade-offs** — what you're giving up with this approach
4. **Complexity rating** — Low / Medium / High implementation effort
5. **Priority** — Must-have for Phase 1, or can wait for Phase 2+?
