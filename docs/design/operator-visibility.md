# Operator Visibility — Design Document

**Issue:** #265
**Epic:** #320
**Status:** Proposed
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-03
**Depends on:** [Agent Capability Model](./agent-capabilities.md) (#264), [Agent Lifecycle & Resilience](./agent-lifecycle.md) (#266)

---

## 1. Problem Statement

Cortex Plane has the core execution loop, a capability binding system (#264), and resilience primitives (#266), but lacks the unified operator surface that makes running agents a managed operation:

1. **No activity stream:** When an agent is executing, the operator's only insight is the final job result. Every intermediate step — LLM calls, tool invocations, state transitions — is invisible.

2. **No cost visibility:** Token usage accrues silently. An operator discovers cost overruns only when the cloud bill arrives. No per-agent, per-session, or per-tool-call cost tracking.

3. **No kill switch:** If an agent enters a bad state (timeout loop, runaway tool calls), the operator cannot stop it mid-execution. The only option is to terminate the entire pod.

4. **No replay/dry-run for debugging:** When an agent produces an unexpected result, there is no way to re-run from a checkpoint with different parameters, or to preview what an agent *would* do without actually executing.

5. **No operations dashboard:** Agent health, cost, activity, and control actions are scattered across individual API endpoints. The operator has no single pane of glass.

### North Star

An operator running 10 agents across 5 channels should be able to see everything happening, control any agent instantly, and never be surprised by agent behavior.

---

## 2. Design Principles

1. **Event-sourced observability.** Every agent action emits a structured event to `agent_event` (PostgreSQL), broadcast via SSE in real-time. All derived views (cost summaries, activity streams, dashboards) are projections over this unified event stream.
2. **Control without destruction.** Pause, steer, and kill operations preserve agent state. The operator can always resume, replay, or inspect the agent after intervention.
3. **Cost is a first-class metric.** Token usage, tool call costs, and session costs are tracked at every level and enforced via budgets.
4. **Progressive disclosure.** The dashboard shows a summary by default. Drill into an agent for the activity stream. Drill into an event for full detail. No information overload at the top level.
5. **Graceful degradation.** If the event bus or SSE connection is unavailable, agents continue executing. Events are persisted to PostgreSQL first and broadcast second.

---

## 3. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                        Agent Execution                            │
│  agent-execute.ts                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ LLM call │  │Tool call │  │State change  │  │  Checkpoint  │ │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  └──────┬───────┘ │
│       │              │               │                  │         │
│       └──────────────┴───────────────┴──────────────────┘         │
│                              │                                    │
│                    AgentEventEmitter                               │
│                     (persist + broadcast)                          │
└──────────────────────────────┬────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     ┌────────────┐   ┌──────────────┐  ┌────────────┐
     │ agent_event│   │SSEConnection │  │CostTracker │
     │ (Postgres) │   │   Manager    │  │ (in-memory │
     │            │   │ (real-time)  │  │  + persist) │
     └─────┬──────┘   └──────┬───────┘  └─────┬──────┘
           │                 │                  │
           ▼                 ▼                  ▼
     ┌──────────┐     ┌──────────┐       ┌──────────┐
     │Event     │     │Dashboard │       │Budget    │
     │Query API │     │Activity  │       │Enforce-  │
     │(REST)    │     │Stream    │       │ment      │
     └──────────┘     └──────────┘       └──────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|---------------|----------------|
| `AgentEventEmitter` | Persist events to `agent_event`, broadcast via SSE | New service (#322) |
| `CostTracker` | Estimate + accumulate costs, enforce budgets | New service (#323) |
| `SSEConnectionManager` | Manage per-agent SSE connections with replay | Existing (`src/streaming/manager.ts`) |
| Event Query API | REST endpoints for historical event queries | New routes (#325) |
| Kill Switch | Cancel in-flight LLM calls + tool executions | New route + manager method (#326) |
| Dry Run | Simulate agent turn without side effects | Implemented (`src/observability/dry-run.ts`) |
| Event Pruning | Scheduled cleanup of old events | Implemented (`src/worker/tasks/prune-agent-events.ts`) |

---

## 4. Event Model

### 4.1 The `agent_event` Table

All agent activity flows through a single event table (migration 021):

```sql
CREATE TABLE agent_event (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  job_id      UUID REFERENCES job(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,
  cost_usd    NUMERIC(12, 6),
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ae_agent ON agent_event(agent_id, created_at DESC);
CREATE INDEX idx_ae_created ON agent_event(created_at);
```

### 4.2 Event Types

| Event Type | Emitted When | `details` Schema | `cost_usd` |
|-----------|-------------|-----------------|------------|
| `llm_call` | LLM request completes | `{ model, tokensIn, tokensOut, latencyMs, cached }` | Estimated |
| `tool_call` | Tool invocation completes | `{ toolRef, input, output, latencyMs, isError }` | If applicable |
| `tool_error` | Tool invocation fails | `{ toolRef, input, error, latencyMs }` | null |
| `llm_error` | LLM call fails/timeouts | `{ model, error, retryCount }` | null |
| `state_transition` | Agent lifecycle state changes | `{ from, to, reason }` | null |
| `checkpoint_write` | Checkpoint persisted | `{ trigger, sizeBytes, crc }` | null |
| `memory_write` | Memory updated (Qdrant) | `{ entryId, sizeChars }` | null |
| `memory_write_rejected` | Memory write blocked by validator | `{ sizeChars, maxChars, violations }` | null |
| `context_budget_exceeded` | Context assembly exceeds budget | `{ component, chars, maxChars }` | null |
| `circuit_breaker_trip` | Agent circuit breaker trips | `{ reason, consecutiveFailures }` | null |
| `session_start` | New session begins | `{ sessionId, channelId }` | null |
| `session_end` | Session completes | `{ sessionId, totalTokens, totalCostUsd }` | Session total |
| `steer_injected` | Operator injects steering message | `{ instruction, priority }` | null |
| `steer_acknowledged` | Agent acknowledges steering | `{ steerMessageId, turnNumber }` | null |
| `kill` | Operator triggers kill switch | `{ reason, cancelledJobId }` | null |
| `budget_warning` | Cost approaching budget threshold | `{ currentUsd, budgetUsd, pct }` | null |
| `budget_exceeded` | Cost exceeds budget | `{ currentUsd, budgetUsd }` | null |

### 4.3 Cost Estimation

Token costs are estimated at write time using per-model pricing:

```typescript
interface ModelPricing {
  inputPer1k: number
  outputPer1k: number
  cachedInputPer1k?: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6':  { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-opus-4-6':    { inputPer1k: 0.015, outputPer1k: 0.075 },
  'claude-haiku-4-5':   { inputPer1k: 0.001, outputPer1k: 0.005 },
  // fallback
  'default':            { inputPer1k: 0.003, outputPer1k: 0.015 },
}
```

Cost is stored on the event row (`cost_usd` column) for efficient aggregation queries without JSON parsing.

---

## 5. Observability Services

### 5.1 AgentEventEmitter

The central event hub. Every component that generates an agent action calls the emitter. The emitter writes to PostgreSQL first, then broadcasts via SSE.

**New file:** `packages/control-plane/src/observability/event-emitter.ts`

```typescript
interface AgentEventEmitterDeps {
  db: Kysely<Database>
  sseManager: SSEConnectionManager
}

class AgentEventEmitter {
  constructor(deps: AgentEventEmitterDeps)

  /** Persist event to agent_event + broadcast via SSE. */
  emit(event: {
    agentId: string
    jobId?: string
    eventType: string
    costUsd?: number
    details?: Record<string, unknown>
  }): Promise<string>  // returns event ID

  /** Emit multiple events in a single transaction. */
  emitBatch(events: Array<{
    agentId: string
    jobId?: string
    eventType: string
    costUsd?: number
    details?: Record<string, unknown>
  }>): Promise<string[]>
}
```

**Persistence-first guarantee:** If SSE broadcast fails (no connections, connection error), the event is still persisted. The client can recover by querying the REST API or reconnecting with `Last-Event-ID`.

**SSE integration:** On emit, the event is broadcast to all active SSE connections for the agent via `SSEConnectionManager.broadcast()`. The SSE event type maps to the `agent_event.event_type` prefixed with `event:`:

```
agent_event.event_type = "llm_call"  →  SSE event = "event:llm_call"
agent_event.event_type = "tool_call" →  SSE event = "event:tool_call"
```

### 5.2 CostTracker

Accumulates costs per agent, per session, and per job. Enforces cost budgets.

**New file:** `packages/control-plane/src/observability/cost-tracker.ts`

```typescript
interface CostBudget {
  maxUsdPerJob?: number
  maxUsdPerSession?: number
  maxUsdPerDay?: number
  warningThresholdPct?: number   // default 80
}

interface CostSnapshot {
  agentId: string
  jobCostUsd: number
  sessionCostUsd: number
  dailyCostUsd: number
  budgetStatus: 'ok' | 'warning' | 'exceeded'
}

class CostTracker {
  constructor(deps: { db: Kysely<Database>; emitter: AgentEventEmitter })

  /** Record token usage and return updated cost snapshot. */
  recordLlmCost(params: {
    agentId: string
    jobId: string
    model: string
    tokensIn: number
    tokensOut: number
    cached?: boolean
  }): Promise<CostSnapshot>

  /** Get current cost snapshot for an agent. */
  getSnapshot(agentId: string, jobId?: string): Promise<CostSnapshot>

  /** Check budget and return whether execution should continue. */
  checkBudget(agentId: string, budget: CostBudget): Promise<{
    allowed: boolean
    reason?: string
    snapshot: CostSnapshot
  }>
}
```

**Budget enforcement flow:**

1. Before each LLM call in `agent-execute.ts`, call `costTracker.checkBudget()`.
2. If `warning` threshold crossed, emit `budget_warning` event.
3. If `exceeded`, emit `budget_exceeded` event and abort the job.

**Cost aggregation queries** (used by `GET /agents` and `GET /agents/:id`):

```sql
-- Per-agent daily cost
SELECT agent_id, SUM(cost_usd) as daily_cost
FROM agent_event
WHERE cost_usd IS NOT NULL
  AND created_at >= CURRENT_DATE
GROUP BY agent_id;

-- Per-agent cost by model
SELECT agent_id, details->>'model' as model,
       SUM(cost_usd) as total_cost,
       COUNT(*) as call_count
FROM agent_event
WHERE event_type = 'llm_call'
  AND created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY agent_id, details->>'model';
```

These queries power the cost summary fields already added to `GET /agents` (#332).

### 5.3 Existing Observability Infrastructure

The following are already implemented and will be wired into the event emitter:

| Component | File | Integration Point |
|-----------|------|-------------------|
| Prometheus metrics | `src/lifecycle/metrics.ts` | `emitLifecycleLog()` calls emit in parallel with event emitter |
| Heartbeat monitoring | `src/lifecycle/health.ts` | `HeartbeatReceiver` feeds `agent:state` SSE events |
| Crash loop detection | `src/lifecycle/health.ts` | `CrashLoopDetector` triggers `circuit_breaker_trip` events |
| Output validation | `src/lifecycle/output-validator.ts` | Rejection triggers `memory_write_rejected` event |
| Idle detection | `src/lifecycle/idle-detector.ts` | Idle timeout triggers `state_transition` event |
| SSE streaming | `src/streaming/manager.ts` | `SSEConnectionManager` with per-agent replay buffers |
| Dry run simulation | `src/observability/dry-run.ts` | Standalone (no events — simulation only) |
| Event retention pruning | `src/worker/tasks/prune-agent-events.ts` | 30-day default, 90-day for cost events |

---

## 6. Activity Stream

### 6.1 SSE Endpoint

Real-time event stream for a single agent.

```
GET /agents/:agentId/events/stream
Headers: Accept: text/event-stream
         Last-Event-ID: <optional, for replay>
Auth: operator or admin
```

**Response:** Server-sent events in standard SSE format:

```
id: 42
event: event:llm_call
data: {"agentId":"...","jobId":"...","eventType":"llm_call","costUsd":0.0045,"details":{"model":"claude-sonnet-4-6","tokensIn":1200,"tokensOut":300,"latencyMs":2100},"createdAt":"2026-03-07T..."}

id: 43
event: event:tool_call
data: {"agentId":"...","eventType":"tool_call","details":{"toolRef":"mcp:slack:chat_postMessage","latencyMs":450},"createdAt":"2026-03-07T..."}
```

**Replay:** If `Last-Event-ID` is provided, the `SSEConnectionManager` replays buffered events from its circular buffer (default 1,000 events). For events older than the buffer, the client must use the REST query API.

### 6.2 REST Query Endpoint

Historical event queries with filtering, pagination, and aggregation.

```
GET /agents/:agentId/events
Query:
  eventType    - filter by event type (comma-separated)
  jobId        - filter by job
  since        - ISO timestamp lower bound
  until        - ISO timestamp upper bound
  limit        - page size (default 50, max 200)
  offset       - pagination offset
  costOnly     - boolean, only events with cost_usd IS NOT NULL
Auth: operator or admin

Response: {
  events: AgentEvent[],
  total: number,
  costSummary?: { totalUsd: number, byModel: Record<string, number> }
}
```

### 6.3 Cross-Agent Event Feed

For the operations dashboard — a merged feed across all agents.

```
GET /events
Query:
  agentIds     - comma-separated agent IDs (optional, all if omitted)
  eventType    - filter by event type
  since        - ISO timestamp lower bound
  limit        - page size (default 50, max 200)
Auth: admin

Response: {
  events: AgentEvent[],
  total: number
}
```

---

## 7. Control Operations

### 7.1 Kill Switch

Immediately cancels an agent's in-flight execution: aborts the current LLM call, cancels pending tool executions, and transitions the agent to DRAINING.

```
POST /agents/:agentId/kill
Body: { reason: string }
Auth: operator or admin

Response: 200 {
  agentId: string,
  previousState: AgentLifecycleState,
  newState: "DRAINING",
  cancelledJobId: string | null,
  reason: string
}
```

**Implementation in `AgentLifecycleManager`:**

```typescript
async kill(agentId: string, reason: string): Promise<KillResult> {
  const ctx = this.contexts.get(agentId)

  // 1. Transition to DRAINING (from EXECUTING, READY, or DEGRADED)
  ctx.stateMachine.transition('DRAINING', `kill: ${reason}`)

  // 2. Cancel in-flight LLM call via AbortController
  if (ctx.executionAbortController) {
    ctx.executionAbortController.abort()
  }

  // 3. Mark current job as FAILED with kill reason
  if (ctx.jobId) {
    await this.db.updateTable('job')
      .set({ status: 'FAILED', error: `Killed by operator: ${reason}` })
      .where('id', '=', ctx.jobId)
      .execute()
  }

  // 4. Emit kill event
  await this.emitter.emit({
    agentId, jobId: ctx.jobId,
    eventType: 'kill',
    details: { reason, cancelledJobId: ctx.jobId }
  })

  // 5. Delete pod (triggers graceful shutdown with checkpoint flush)
  await this.deployer.deletePod(agentId)

  return { agentId, previousState, newState: 'DRAINING', cancelledJobId: ctx.jobId, reason }
}
```

**Key difference from `drain()`:** Kill cancels the in-flight execution immediately via `AbortController`. Drain waits for the current step to complete.

**Key difference from `terminate()`:** Kill goes through DRAINING (allowing checkpoint flush). Terminate is a hard stop from any state.

### 7.2 Pause / Resume (Existing)

Already implemented in `AgentLifecycleManager`:

```
POST /agents/:agentId/pause    →  checkpoint write, job → WAITING_FOR_APPROVAL
POST /agents/:agentId/resume   →  job → RUNNING from checkpoint
```

Both return 202 (Accepted). Resume accepts optional `checkpointId` and `instruction` for resuming from a specific checkpoint or injecting guidance.

### 7.3 Enhanced Steer (Implemented — #327)

Mid-execution message injection with acknowledgment tracking.

```
POST /agents/:agentId/steer
Body: { instruction: string, priority: "normal" | "urgent" }
```

The `AgentLifecycleManager` supports:
- `steer(msg)` — inject instruction (requires EXECUTING state)
- `steerAsync(msg, timeoutMs)` — wait for acknowledgment
- `acknowledgeSteer(steerMessageId, turnNumber)` — ack from execution loop

SSE events: `steer:injected`, `steer:acknowledged`.

### 7.4 Replay

Re-run an agent from a checkpoint with optional modifications.

```
POST /agents/:agentId/replay
Body: {
  checkpointId: string,
  modifications?: {
    instruction?: string,        // Override system prompt injection
    model?: string,              // Use different model
    resourceLimits?: Partial<ResourceLimits>,
    dryRun?: boolean             // Preview only, no execution
  }
}
Auth: admin

Response: 202 {
  replayJobId: string,
  fromCheckpoint: string,
  modifications: object
}
```

**Replay procedure:**
1. Load target checkpoint from `agent_checkpoint`.
2. Validate checkpoint integrity (CRC32 via `verifyCheckpointIntegrity()`).
3. Create a new job with the checkpoint state and any modifications.
4. If `dryRun: true`, route through the dry-run path (`src/observability/dry-run.ts`).
5. Otherwise, enqueue as a normal job via Graphile Worker.
6. The replay job links to the source checkpoint for audit.

**Dependencies:** `agent_checkpoint` table (migration 020), checkpoint CRUD (#266-T7).

### 7.5 Dry Run (Implemented — #329)

Simulates an agent turn without executing tools.

```
POST /agents/:agentId/dry-run
Body: { message: string, sessionId?: string, maxTurns?: number }

Response: {
  plannedActions: Array<{ type: "tool_call", toolRef: string, input: object }>,
  agentResponse: string,
  tokensUsed: { in: number, out: number },
  estimatedCostUsd: number
}
```

Implemented in `src/observability/dry-run.ts`. Stubs tool execution with `[DRY RUN]` markers, loads conversation context from `session_message`, and estimates cost using default pricing.

---

## 8. Event Retention & Storage

### 8.1 Retention Policy

Implemented in `src/worker/tasks/prune-agent-events.ts`:

| Event Category | Retention | Rationale |
|---------------|-----------|-----------|
| Non-cost events (tool calls, state transitions, etc.) | 30 days | Operational debugging window |
| Cost events (`cost_usd IS NOT NULL`) | 90 days | Billing reconciliation period |

Configuration via `EventRetentionConfig`:
```typescript
interface EventRetentionConfig {
  defaultDays?: number      // Default: 30
  costEventDays?: number    // Default: 90
  batchSize?: number        // Default: 1000
}
```

Pruning runs as a Graphile Worker cron task daily at 03:00 UTC. Deletes in batches to avoid long-held locks.

### 8.2 Storage Estimates

For a fleet of 10 agents with moderate activity:

| Metric | Estimate |
|--------|----------|
| Events per agent per day | ~500 (100 LLM calls + 200 tool calls + 200 misc) |
| Average event row size | ~400 bytes (UUID + refs + JSONB details) |
| Daily ingestion (10 agents) | ~2 MB |
| 30-day storage (non-cost) | ~60 MB |
| 90-day storage (cost) | ~18 MB (cost events are ~10% of total) |
| Total steady-state | ~80 MB |

PostgreSQL handles this volume trivially. The `idx_ae_agent` and `idx_ae_created` indexes ensure query performance. No external event store needed at this scale.

### 8.3 Future: External Event Sink

If event volume grows beyond PostgreSQL comfort (>100 agents, >50K events/day), the `AgentEventEmitter` can be extended with a pluggable sink interface:

```typescript
interface EventSink {
  write(event: AgentEvent): Promise<void>
}
```

Candidate sinks: CloudWatch Logs, Kafka, or a time-series database. This is not in scope for the initial implementation.

---

## 9. Dashboard — Operations Page

### 9.1 Information Architecture

The operations dashboard is a new top-level page accessible to operators and admins.

```
/operations
├── Fleet Overview (all agents summary)
│   ├── Active / Degraded / Quarantined / Terminated counts
│   ├── Total cost today / this week / this month
│   └── Recent alerts (circuit breaker trips, budget warnings)
│
├── Agent Cards (one per agent)
│   ├── Name, status, health indicator
│   ├── Current activity (executing / idle / quarantined)
│   ├── Cost today
│   └── Quick actions: [Pause] [Kill] [Steer]
│
└── Activity Feed (cross-agent, most recent events)

/agents/:id/operations
├── Activity Stream (real-time SSE)
│   ├── LLM calls with token counts + cost
│   ├── Tool calls with input/output
│   ├── State transitions
│   └── Steering events
│
├── Cost Breakdown
│   ├── By model (pie chart)
│   ├── By day (bar chart)
│   └── Budget status
│
├── Control Actions
│   ├── [Pause] [Resume] [Kill] [Steer]
│   ├── [Dry Run] — preview next turn
│   └── [Replay] — re-run from checkpoint
│
└── Health & Diagnostics
    ├── Lifecycle state
    ├── Circuit breaker status
    ├── Last heartbeat
    ├── Checkpoint history
    └── Subsystem health (DB, Qdrant, MCP servers)
```

### 9.2 Component Layout

```
┌─────────────────────────────────────────────────────┐
│  OPERATIONS                                   [Admin] │
├─────────────────────────────────────────────────────┤
│                                                       │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │ Active  │ │Degraded │ │Quarant. │ │  Cost   │  │
│  │   7     │ │   1     │ │   0     │ │ $12.40  │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│                                                       │
│  ┌─ Agent Cards ──────────────────────────────────┐  │
│  │ ● Modulus       EXECUTING  $3.20   [Pause][Kill]│  │
│  │ ● Scheduler     READY      $0.80   [Pause][Kill]│  │
│  │ ▲ Watchdog      DEGRADED   $1.50   [Pause][Kill]│  │
│  │ ● Outreach      EXECUTING  $2.10   [Pause][Kill]│  │
│  │ ...                                              │  │
│  └──────────────────────────────────────────────────┘  │
│                                                       │
│  ┌─ Activity Feed ────────────────────────────────┐  │
│  │ 14:32:05  Modulus    tool_call   slack:send     │  │
│  │ 14:32:03  Modulus    llm_call    sonnet  $0.004 │  │
│  │ 14:31:58  Outreach   tool_call   gmail:send     │  │
│  │ 14:31:55  Scheduler  state       READY→EXEC     │  │
│  │ ...                                              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 9.3 Agent Operations Tab

Integrated into the existing agent detail page as a new tab alongside "Sessions", "Jobs", "Capabilities".

```
┌─ Agent: Modulus ──────────────────────────────────────┐
│ [Overview] [Sessions] [Jobs] [Capabilities] [Ops]     │
├───────────────────────────────────────────────────────┤
│                                                        │
│  ┌─ Control ─────┐  ┌─ Health ─────────────────────┐ │
│  │ [Pause]       │  │ State: EXECUTING              │ │
│  │ [Kill]        │  │ Health: HEALTHY ●              │ │
│  │ [Steer...]    │  │ Heartbeat: 3s ago             │ │
│  │ [Dry Run...]  │  │ Circuit breaker: OK (0/3)     │ │
│  │ [Replay...]   │  │ Token budget: 42% used        │ │
│  └───────────────┘  └──────────────────────────────┘ │
│                                                        │
│  ┌─ Activity Stream (live) ────────────────────────┐ │
│  │ [All] [LLM] [Tools] [State] [Cost]              │ │
│  │                                                   │ │
│  │ 14:32:05  tool_call  mcp:slack:chat_postMessage  │ │
│  │           input: { channel: "#general", ... }     │ │
│  │           output: "ok"  450ms                     │ │
│  │                                                   │ │
│  │ 14:32:03  llm_call   claude-sonnet-4-6           │ │
│  │           1,200 in / 300 out  $0.0045  2.1s      │ │
│  │                                                   │ │
│  │ 14:31:55  state_transition  READY → EXECUTING    │ │
│  │           reason: job dispatched                   │ │
│  └───────────────────────────────────────────────────┘ │
│                                                        │
│  ┌─ Cost ──────────────────────────────────────────┐ │
│  │ Today: $3.20  │  This week: $18.40               │ │
│  │ By model: sonnet-4-6 $2.80 (87%)                 │ │
│  │           haiku-4-5  $0.40 (13%)                  │ │
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

---

## 10. Alert & Notification Model

### 10.1 Alert Events

Certain events are classified as alerts requiring operator attention:

| Alert | Trigger Event | Severity | Default Action |
|-------|--------------|----------|----------------|
| Circuit breaker trip | `circuit_breaker_trip` | Critical | Quarantine agent |
| Budget exceeded | `budget_exceeded` | Critical | Abort job |
| Budget warning | `budget_warning` | Warning | Log + SSE notify |
| Consecutive tool errors | 5+ `tool_error` in a row | Warning | Log + SSE notify |
| Heartbeat timeout | 3 missed heartbeats (45s) | Critical | Mark UNHEALTHY |
| Crash loop detected | 3+ crashes in 30 min | Critical | Apply backoff cooldown |
| Output validation rejected | `memory_write_rejected` | Warning | Log + SSE notify |

### 10.2 Notification Channels

Alerts are delivered via:

1. **SSE stream** — real-time push to connected dashboard clients.
2. **`agent_event` table** — persisted for historical query.
3. **Prometheus metrics** — counters for alerting via Grafana/PagerDuty.
4. **Structured logs** — via `emitLifecycleLog()` for log aggregation (ELK, CloudWatch).

**Future (not in scope):** Webhook notifications (Slack, Discord, email) for critical alerts. The event emitter's pluggable sink interface (see 8.3) provides the extension point.

### 10.3 Existing Prometheus Metrics

Defined in `src/lifecycle/metrics.ts`:

| Metric | Type | Labels |
|--------|------|--------|
| `cortex_agent_state_transitions_total` | Counter | `agent_id`, `from`, `to` |
| `cortex_agent_circuit_breaker_trips_total` | Counter | `agent_id`, `reason` |
| `cortex_agent_context_budget_exceeded_total` | Counter | `agent_id`, `component` |
| `cortex_agent_output_validation_rejected_total` | Counter | `agent_id`, `content_type` |
| `cortex_agent_checkpoint_writes_total` | Counter | `agent_id`, `trigger` |
| `cortex_agent_token_usage_total` | Counter | `agent_id`, `job_id` |
| `cortex_agent_quarantine_duration_seconds` | Histogram | `agent_id` |
| `cortex_agent_health_probe_duration_seconds` | Histogram | `agent_id` |

---

## 11. Wiring Into Agent Execution

### 11.1 Integration Points in `agent-execute.ts`

The event emitter and cost tracker are injected into the agent execution task:

```typescript
// In createAgentExecuteTask deps
interface AgentExecuteTaskDeps {
  // ... existing deps ...
  emitter?: AgentEventEmitter
  costTracker?: CostTracker
}
```

**Emit points:**

| Execution Phase | Event | Data |
|----------------|-------|------|
| Before LLM call | (cost budget check) | — |
| After LLM call | `llm_call` | model, tokens, cost, latency |
| LLM call error | `llm_error` | model, error, retry count |
| Before tool call | (rate limit check via CapabilityGuard) | — |
| After tool call | `tool_call` | toolRef, input, output, latency |
| Tool call error | `tool_error` | toolRef, input, error |
| State transition | `state_transition` | from, to, reason |
| Checkpoint write | `checkpoint_write` | trigger, size, CRC |
| Job start | `session_start` | sessionId, channelId |
| Job complete | `session_end` | sessionId, total tokens, total cost |

### 11.2 AbortController for Kill Switch

Each agent execution receives an `AbortController`. The kill switch aborts it:

```typescript
// In agent-execute.ts
const abortController = new AbortController()
ctx.executionAbortController = abortController

// Pass to LLM backend
const response = await backend.chat({
  messages,
  tools,
  signal: abortController.signal,  // AbortSignal
})

// On kill:
abortController.abort()
// → backend.chat() throws AbortError
// → execution loop catches, writes checkpoint, exits
```

---

## 12. API Surface Summary

### 12.1 New Endpoints

```
GET    /agents/:agentId/events/stream    — SSE activity stream
GET    /agents/:agentId/events           — Historical event query
GET    /events                            — Cross-agent event feed (admin)
POST   /agents/:agentId/kill             — Kill switch
POST   /agents/:agentId/replay           — Replay from checkpoint
```

### 12.2 Existing Endpoints (Already Implemented)

```
POST   /agents/:agentId/dry-run          — Simulate turn (#329)
POST   /agents/:agentId/pause            — Pause execution
POST   /agents/:agentId/resume           — Resume from checkpoint
POST   /agents/:agentId/steer            — Steering injection (#327)
GET    /agents                            — List with cost + health (#332)
```

### 12.3 Endpoints from Related Epics

```
POST   /agents/:agentId/quarantine       — Freeze agent (#266)
POST   /agents/:agentId/release          — Release from quarantine (#266)
GET    /agents/:agentId/health           — Health probe (#266)
GET    /agents/:agentId/checkpoints      — Checkpoint list (#266)
POST   /agents/:agentId/checkpoints      — Manual checkpoint (#266)
POST   /agents/:agentId/rollback         — Restore checkpoint (#266)
```

---

## 13. Epic Breakdown — Implementation Tickets

**Epic:** #320

| # | Ticket | Issue | Size | Status | Dependencies |
|---|--------|-------|------|--------|-------------|
| T1 | DB migration — `agent_event` table + job/session cost columns | #321 | M | Done (migration 021) | None |
| T2 | AgentEventEmitter service — persist + broadcast events | #322 | L | Open | T1 |
| T3 | CostTracker service — estimation, accumulation, budget enforcement | #323 | L | Open | T1, T2 |
| T4 | Wire event emitter + cost tracker into agent-execute | #324 | M | Open | T2, T3 |
| T5 | Activity stream SSE + event query REST endpoints | #325 | M | Open | T2 |
| T6 | Kill switch — immediate execution cancellation | #326 | M | Open | T4 |
| T7 | Enhanced steer — acknowledgment + operator feedback loop | #327 | S | **Done** | T2, T4 |
| T8 | Replay — re-run from checkpoint with modifications | #328 | M | Open | #266-T6, #266-T7 |
| T9 | Dry run — simulate agent turn without tool execution | #329 | S | **Done** | T2, T3 |
| T10 | Event retention pruning task | #330 | S | **Done** | T1 |
| T11 | Dashboard — operations page + agent operations tab | #331 | L | Open | T5, T6, T7, T9 |
| T12 | Extend GET /agents with cost + health summary fields | #332 | S | **Done** | T1, T3 |

### Dependency Graph

```
T1 (migration) ✓
├── T2 (event emitter)
│   ├── T3 (cost tracker)
│   │   ├── T4 (wire into agent-execute)
│   │   │   ├── T6 (kill switch)
│   │   │   └── T7 (enhanced steer) ✓
│   │   └── T12 (extend /agents API) ✓
│   ├── T5 (SSE + REST endpoints)
│   └── T9 (dry run) ✓
├── T10 (event pruning) ✓

T8 (replay)                           ← #266-T6, #266-T7

T11 (dashboard)                       ← T5, T6, T7, T9
```

**Critical path:** T2 → T3 → T4 → T6 → T11

**Next tickets to implement:** T2 (AgentEventEmitter) and T5 (activity stream endpoints) can proceed in parallel.

---

## 14. Answers to Spike Questions (#265)

### Observability

| # | Question | Answer |
|---|----------|--------|
| 1 | Agent activity stream? | SSE endpoint `GET /agents/:id/events/stream` with replay buffer. REST `GET /agents/:id/events` for historical queries. (§6) |
| 2 | Subagent tree? | Flat supervision model (#266 §7.2). No persistent parent-child hierarchy — subagent relationships are per-job. Event stream includes all agents equally. Future: add `parent_agent_id` to `agent_event.details` for delegation events. |
| 3 | Cost tracking? | `CostTracker` service accumulates per-agent/session/job costs. Estimated at LLM call time using model pricing table. Stored in `agent_event.cost_usd`. (§5.2) |
| 4 | Token usage? | Recorded per LLM call in `agent_event.details.{tokensIn, tokensOut}`. Accumulated per session in `session_end` event. (§4.2) |
| 5 | Tool call audit log? | Every tool invocation emits `tool_call` event with input, output, duration, and credential context. `capability_audit_log` (#264) provides per-binding audit. (§4.2) |

### Guardrails

| # | Question | Answer |
|---|----------|--------|
| 6 | Capability boundaries? | `agent_tool_binding` table (#264). Agent cannot access unbound tools. Enforced by `CapabilityAssembler` + `CapabilityGuard`. |
| 7 | Resource limits? | Agent-level circuit breaker (#266 §5): token budgets per job/session, tool call rate limits, consecutive failure thresholds. Cost budgets per `CostTracker`. (§5.2) |
| 8 | Output validation? | `validateMemoryWrite()` and `validateCheckpointWrite()` in `src/lifecycle/output-validator.ts`. Rejects binary content, enforces size limits, CRC32 integrity. (#266 §4.2) |
| 9 | Kill switch? | `POST /agents/:id/kill` — cancels in-flight LLM call via `AbortController`, marks job FAILED, transitions to DRAINING. (§7.1) |
| 10 | Rollback? | `POST /agents/:id/rollback` — restores from versioned `agent_checkpoint`. (#266 §6.2) |

### Control

| # | Question | Answer |
|---|----------|--------|
| 11 | Pause/resume? | Implemented. `POST /agents/:id/pause` checkpoints + pauses. `POST /agents/:id/resume` resumes from checkpoint with optional instruction. (§7.2) |
| 12 | Steer? | Implemented (#327). `POST /agents/:id/steer` with acknowledgment tracking. SSE events for injection + ack. (§7.3) |
| 13 | Replay? | `POST /agents/:id/replay` — re-run from checkpoint with optional model/instruction/limit modifications. Can be combined with dry run. (§7.4) |
| 14 | Dry run? | Implemented (#329). `POST /agents/:id/dry-run` — simulates turn, returns planned actions + cost estimate. (§7.5) |

### Dashboard

| # | Question | Answer |
|---|----------|--------|
| 15 | What does the dashboard look like? | Operations page (fleet overview + agent cards + cross-agent feed) + per-agent operations tab (activity stream + cost breakdown + control actions + health). (§9) |
| 16 | Dedicated or integrated? | Both. Dedicated `/operations` page for fleet-wide view. Integrated "Ops" tab on agent detail page for per-agent view. (§9.1) |
