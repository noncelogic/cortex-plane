# Agent Lifecycle & Resilience — Design Document

**Issue:** #266
**Status:** Proposed
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-03
**Depends on:** [Spike #34 — Agent Lifecycle](../spikes/034-agent-lifecycle.md), [Agent Capability Model](./agent-capabilities.md)

---

## 1. Problem Statement

OpenClaw agents are self-destructive. Observed failure modes from production:

1. **Context budget spiral:** An agent wrote a 5,517-char IDENTITY.md, leaving 224 chars for MEMORY.md. Truncated context produced garbled tool calls (`read tool called without path`), causing 5-minute Antigravity API timeouts, a stuck retry loop, gateway restarts, and 5 restarts in 6 hours.

2. **Autonomous overreach:** A pipeline watchdog cron labeled "READ-ONLY" modified `pipeline-state.json`. Another cron filed 10 tickets autonomously. Prompt constraints are an honor system with no platform enforcement.

3. **No circuit breakers at the agent level:** If an LLM call times out, OpenClaw retries indefinitely. No backoff, no budget check, no "this agent is in a bad state, stop it."

4. **State corruption:** An agent writes bad data to its config/memory files. The next session loads corrupted state, causing cascading failure with no recovery path.

### North Star

An agent should never be able to put itself in an unrecoverable state. The platform catches failures before they cascade and provides the operator with clear recovery options.

---

## 2. Design Principles

1. **Platform enforces, agents comply.** Safety invariants are enforced by the platform, not by agent prompts.
2. **Fail closed.** When in doubt, stop the agent. A paused agent is better than a runaway agent.
3. **Observable degradation.** Every state change, budget breach, and circuit trip is logged, metered, and surfaced to the operator.
4. **Checkpoint-first recovery.** Recovery always resumes from the last known-good checkpoint. No re-execution from scratch unless the operator explicitly requests it.
5. **Layered defense.** No single mechanism is the sole safety net. Context budgets, circuit breakers, output validation, and health checks each catch different failure modes.

---

## 3. Extended Agent Lifecycle State Machine

### 3.1 New States

The current 6-state model (`BOOTING → HYDRATING → READY → EXECUTING → DRAINING → TERMINATED`) from spike #34 covers the happy path. Issue #266 adds three states for failure and operational modes:

| State | Description | Entry condition |
|-------|-------------|-----------------|
| `DEGRADED` | Agent is executing but one or more subsystems are impaired (e.g., Qdrant unreachable, MCP server OPEN, memory writes failing). Execution continues with reduced capability. | Subsystem health check fails during `EXECUTING`. |
| `QUARANTINED` | Agent is frozen. No new jobs dispatched. Existing execution suspended. Operator intervention required. | Consecutive failure threshold exceeded, or operator manual quarantine via API. |
| `SAFE_MODE` | Agent booted with minimal config: no tools, no memory, identity-only system prompt. Used for debugging a broken agent without risking further damage. | Operator boots agent with `?mode=safe` query param. |

### 3.2 Complete State Machine Diagram

```
                         ┌─────────────────────────────────────────────────────┐
                         │                    TERMINATED                        │
                         │              (terminal, no exit)                     │
                         └──────────▲──────▲──────▲──────▲─────────────────────┘
                                    │      │      │      │
                    drain complete  │      │      │      │ crash / OOM / SIGKILL
                                    │      │      │      │
┌──────────┐  config loaded  ┌──────┴───┐  │  ┌───┴──────┴───┐  subsystem  ┌──────────┐
│ BOOTING  ├────────────────►│HYDRATING │  │  │  EXECUTING   │◄───────────►│ DEGRADED │
│          │                 │          │  │  │              │  recovered   │          │
└────┬─────┘                 └────┬─────┘  │  └──┬──────┬───┘              └────┬─────┘
     │ fatal error                │        │     │      │                       │
     └────────────────────────────┼────────┘     │      │ circuit breaker       │
                                  │ hydrated     │      │ trips / operator      │
                                  ▼              │      ▼                       │
                           ┌──────────┐   start  │  ┌───────────────┐          │
                           │  READY   ├──────────┘  │ QUARANTINED   │◄─────────┘
                           │          │             │ (frozen)       │
                           └────┬─────┘             └───────┬───────┘
                                │ SIGTERM                    │ operator
                                ▼                            │ releases
                           ┌──────────┐                      │
                           │ DRAINING ├──────────────────────┘
                           └──────────┘        (re-boot)

                           ┌──────────┐
                           │SAFE_MODE │  (isolated boot path, operator-initiated)
                           │          │──► READY (limited) ──► EXECUTING (no tools)
                           └──────────┘
```

### 3.3 Transition Rules

```
BOOTING       → HYDRATING                   config loaded, DB connected
BOOTING       → TERMINATED                  fatal boot error

HYDRATING     → READY                       checkpoint loaded, context fetched
HYDRATING     → TERMINATED                  fatal hydration error

READY         → EXECUTING                   job dispatched
READY         → DRAINING                    SIGTERM before execution

EXECUTING     → DRAINING                    SIGTERM, job complete, or graceful stop
EXECUTING     → TERMINATED                  crash, OOM, SIGKILL
EXECUTING     → DEGRADED                    subsystem failure detected
EXECUTING     → QUARANTINED                 circuit breaker trips (consecutive failures)

DEGRADED      → EXECUTING                   subsystem recovers
DEGRADED      → QUARANTINED                 further failures, operator quarantine
DEGRADED      → DRAINING                    SIGTERM
DEGRADED      → TERMINATED                  crash

QUARANTINED   → DRAINING                    operator releases → re-boot
QUARANTINED   → TERMINATED                  operator terminates

DRAINING      → TERMINATED                  cleanup complete

SAFE_MODE     → READY                       minimal hydration complete (no tools/memory)
SAFE_MODE     → TERMINATED                  fatal error
```

### 3.4 Who Decides State Changes

| Transition | Decider | Mechanism |
|-----------|---------|-----------|
| BOOTING → HYDRATING | Platform (automatic) | Boot sequence |
| EXECUTING → DEGRADED | Platform (automatic) | Subsystem health monitor |
| EXECUTING → QUARANTINED | Platform (automatic) or Operator (manual) | Circuit breaker or `POST /agents/:id/quarantine` |
| QUARANTINED → DRAINING | Operator (manual) | `POST /agents/:id/release` |
| Any → SAFE_MODE | Operator (manual) | `POST /agents/:id/boot?mode=safe` |
| DEGRADED → EXECUTING | Platform (automatic) | Subsystem health recovery |

---

## 4. Self-Destruction Prevention

### 4.1 Context Budget Enforcement

The platform computes and enforces max sizes for each context component. The agent cannot exceed them.

**Budget model** (stored in `agent.resource_limits`):

```jsonc
{
  "contextBudget": {
    "maxSystemPromptChars": 8000,       // hard cap on system prompt length
    "maxIdentityChars": 4000,           // IDENTITY.md equivalent
    "maxMemoryChars": 4000,             // MEMORY.md equivalent
    "maxToolDefinitionsChars": 16000,   // serialized tool schemas
    "maxTotalContextChars": 120000,     // overall context window budget
    "reservedForConversation": 40000    // minimum chars reserved for conversation history
  }
}
```

**Enforcement points:**

| Component | Where enforced | What happens on exceed |
|-----------|----------------|----------------------|
| System prompt | `buildExecutionTask()` | Truncate with `[TRUNCATED: exceeded ${max} chars]` suffix |
| Identity (IDENTITY.md) | `hydrateAgent()` | Truncate, log warning, set DEGRADED if >50% lost |
| Memory (MEMORY.md) | `hydrateAgent()` | Truncate, log warning |
| Tool definitions | `CapabilityAssembler.buildToolDefinitions()` | Hard cap at `maxTools` (default 40), drop lowest-priority tools |
| Total context | `buildExecutionTask()` final assembly | Error — refuse to dispatch job, log `context_budget_exceeded` |

**New function:** `validateContextBudget()` in `packages/control-plane/src/lifecycle/context-budget.ts`

```typescript
interface ContextBudgetConfig {
  maxSystemPromptChars: number
  maxIdentityChars: number
  maxMemoryChars: number
  maxToolDefinitionsChars: number
  maxTotalContextChars: number
  reservedForConversation: number
}

interface BudgetResult {
  valid: boolean
  components: Record<string, { chars: number; max: number; truncated: boolean }>
  totalChars: number
  warnings: string[]
}

function validateContextBudget(
  context: ExecutionContext,
  config: ContextBudgetConfig,
): BudgetResult
```

### 4.2 Output Validation

Before storing agent-generated content (memory updates, config changes), the platform validates format and size.

**Validation rules:**

| Content type | Max size | Format | On violation |
|-------------|----------|--------|-------------|
| Memory write (Qdrant) | 8,000 chars per entry | UTF-8 text, no binary | Reject write, log `memory_write_rejected` |
| Checkpoint JSONB | 256 KB | Valid JSON, CRC32 integrity | Reject write, keep previous checkpoint |
| Session message | 100,000 chars | UTF-8 text | Truncate with marker |
| Config update (if ever allowed) | N/A | N/A | **Blocked — see 4.3** |

**New function:** `validateAgentOutput()` in `packages/control-plane/src/lifecycle/output-validator.ts`

```typescript
interface OutputValidationResult {
  valid: boolean
  sanitized: string | Record<string, unknown>
  violations: string[]
}

function validateMemoryWrite(content: string, maxChars?: number): OutputValidationResult
function validateCheckpointWrite(data: Record<string, unknown>, maxBytes?: number): OutputValidationResult
```

### 4.3 Immutable Core Config

Agents **cannot** modify their own identity, system prompt, or skill configuration. These are operator-controlled.

| Config field | Agent can read | Agent can write | Requires operator approval |
|-------------|---------------|-----------------|---------------------------|
| `agent.name`, `agent.role` | Yes | No | N/A (immutable) |
| `agent.model_config.systemPrompt` | Yes | No | Yes (via dashboard) |
| `agent.skill_config` | Yes | No | Yes (via dashboard) |
| `agent.resource_limits` | Yes | No | Yes (via dashboard) |
| Memory (Qdrant) | Yes | Yes (validated) | No |
| Checkpoint (JSONB) | Yes | Yes (validated) | No |

**Enforcement:** The agent execution sandbox has no write path to the `agent` table. The `agent-execute` task reads agent config at the start and never writes it back. Tool registries do not include any tool that can modify `agent.*` rows.

---

## 5. Circuit Breakers — Agent-Level

### 5.1 Existing Infrastructure

The codebase already has a per-provider `CircuitBreaker` in `packages/shared/src/backends/circuit-breaker.ts` (CLOSED/OPEN/HALF_OPEN). This design adds an **agent-level** circuit breaker that monitors the agent's own behavior, independent of the backend provider.

### 5.2 Agent Circuit Breaker Configuration

Stored in `agent.resource_limits.circuitBreaker`:

```jsonc
{
  "circuitBreaker": {
    "maxConsecutiveFailures": 3,       // consecutive job failures → QUARANTINED
    "maxToolErrorsPerJob": 10,         // tool errors in a single job → abort job
    "maxLlmRetriesPerJob": 5,          // LLM call retries per job → abort job
    "tokenBudgetPerJob": 500000,       // hard token cutoff per job
    "tokenBudgetPerSession": 2000000,  // hard token cutoff per session
    "toolCallRateLimit": {
      "maxCalls": 50,                  // max tool calls per window
      "windowSeconds": 300             // 5-minute window
    },
    "llmCallRateLimit": {
      "maxCalls": 20,                  // max LLM calls per window
      "windowSeconds": 300
    }
  }
}
```

### 5.3 Circuit Breaker Service

**New file:** `packages/control-plane/src/lifecycle/agent-circuit-breaker.ts`

```typescript
interface AgentCircuitBreakerConfig {
  maxConsecutiveFailures: number
  maxToolErrorsPerJob: number
  maxLlmRetriesPerJob: number
  tokenBudgetPerJob: number
  tokenBudgetPerSession: number
  toolCallRateLimit: { maxCalls: number; windowSeconds: number }
  llmCallRateLimit: { maxCalls: number; windowSeconds: number }
}

interface AgentCircuitBreakerState {
  consecutiveJobFailures: number
  currentJobToolErrors: number
  currentJobLlmRetries: number
  currentJobTokensUsed: number
  currentSessionTokensUsed: number
  toolCallsInWindow: Array<{ timestamp: number }>
  llmCallsInWindow: Array<{ timestamp: number }>
  tripped: boolean
  tripReason: string | null
}

class AgentCircuitBreaker {
  constructor(agentId: string, config: AgentCircuitBreakerConfig)

  /** Record a successful job completion. Resets consecutive failure count. */
  recordJobSuccess(): void

  /** Record a job failure. Increments consecutive failure count. */
  recordJobFailure(): void

  /** Record a tool call. Returns false if rate limit exceeded. */
  recordToolCall(): boolean

  /** Record an LLM call. Returns false if rate limit exceeded. */
  recordLlmCall(): boolean

  /** Record token usage. Returns false if budget exceeded. */
  recordTokenUsage(tokens: number): boolean

  /** Record a tool error in the current job. */
  recordToolError(): void

  /** Check if the agent should be quarantined. */
  shouldQuarantine(): { quarantine: boolean; reason: string }

  /** Check if the current job should be aborted. */
  shouldAbortJob(): { abort: boolean; reason: string }

  /** Reset all counters (e.g., on operator release from quarantine). */
  reset(): void
}
```

### 5.4 LLM Call Timeout with Exponential Backoff

Currently, `agent-execute.ts` relies on the backend's timeout. This design adds explicit timeout management:

```typescript
const LLM_TIMEOUT_CONFIG = {
  initialTimeoutMs: 120_000,     // 2 minutes for first attempt
  maxTimeoutMs: 300_000,         // 5 minutes absolute max
  backoffMultiplier: 1.5,        // each retry increases timeout
  maxRetries: 3,                 // per LLM call
  interChunkTimeoutMs: 60_000,   // 60s between streamed chunks
}
```

**Wiring:** Inject into `ExecutionTask.constraints` and enforce in the backend execution layer.

---

## 6. Checkpoint / Recovery Architecture

### 6.1 Checkpointing

The existing checkpoint system (`job.checkpoint` JSONB + `job.checkpoint_crc` CRC32) is the foundation. This design adds:

**Periodic snapshots** — not just on step completion:

| Checkpoint trigger | What is saved | Storage |
|-------------------|---------------|---------|
| After each completed step | Full agent state | `job.checkpoint` JSONB |
| Every 60 seconds during execution | Incremental state delta | `job.checkpoint` JSONB (overwrite) |
| Before drain | Final state snapshot | `job.checkpoint` JSONB |
| On operator request | Full agent state + metadata | `agent_checkpoint` table (new, versioned) |

**New table:** `agent_checkpoint`

```sql
CREATE TABLE agent_checkpoint (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  job_id        UUID REFERENCES job(id) ON DELETE SET NULL,
  label         TEXT,                          -- operator-assigned label, e.g. 'pre-deploy'
  state         JSONB NOT NULL,                -- full serialized agent state
  state_crc     INTEGER NOT NULL,              -- CRC32 integrity check
  context_snapshot JSONB,                      -- system prompt, tool list, memory at time of checkpoint
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL DEFAULT 'system' -- 'system' | 'operator' | agent_id
);

CREATE INDEX idx_acp_agent ON agent_checkpoint(agent_id, created_at DESC);
```

### 6.2 Rollback

Restore an agent to a previous checkpoint:

```
POST /agents/:agentId/rollback
Body: { checkpointId: string }
```

**Rollback procedure:**
1. Quarantine the agent (stop any running job).
2. Load the target checkpoint.
3. Validate checkpoint integrity (CRC32).
4. Write checkpoint state to `job.checkpoint` for the next job.
5. Optionally restore `context_snapshot` (system prompt, tool bindings) if operator requests full rollback.
6. Release agent from quarantine → BOOTING.

### 6.3 Safe Mode

Boot an agent with minimal config for debugging:

```
POST /agents/:agentId/boot?mode=safe
```

**Safe mode restrictions:**
- No tools (empty tool registry).
- No memory context (skip Qdrant hydration).
- Identity-only system prompt: `"You are ${agent.name}. You are in SAFE MODE. No tools are available. Respond to operator messages only."`
- Token budget: 10,000 (minimal).
- Single-turn only (no multi-step execution).
- All outputs logged to `agent_checkpoint` for review.

### 6.4 Health Checks

The existing `HeartbeatReceiver` (15s interval, 45s timeout) provides process-level health. This design adds an **application-level health probe**:

**Coherence probe** — periodic lightweight test:

```typescript
interface HealthProbeResult {
  healthy: boolean
  latencyMs: number
  issues: string[]
}

async function probeAgentHealth(agentId: string): Promise<HealthProbeResult> {
  // 1. Check heartbeat freshness
  // 2. Check last job completion status
  // 3. Check memory subsystem (can we read from Qdrant?)
  // 4. Check token budget remaining
  // 5. Check circuit breaker state
  return { healthy, latencyMs, issues }
}
```

**Probe schedule:** Every 60 seconds for EXECUTING agents. Every 300 seconds for READY (idle) agents.

**Probe results feed into:**
- Dashboard agent status card.
- DEGRADED state transition (if subsystem fails).
- QUARANTINED state transition (if probe consistently fails).

---

## 7. Multi-Agent Resilience

### 7.1 Agent Dependency Failure

When Agent A depends on Agent B (e.g., A calls B via subagent delegation) and B dies:

| Scenario | Detection | Response |
|----------|-----------|----------|
| B's job fails | A's tool call to B returns error | A receives tool error, classifies as TRANSIENT, retries per circuit breaker config |
| B is quarantined | A's delegation request is rejected (B not in ACTIVE/EXECUTING) | A receives `AgentUnavailableError`, marks tool as unavailable for this job |
| B is in crash loop | A's delegation blocked by B's cooldown | A receives `AgentInCooldownError` with retry-after timestamp |

**No automatic cascading quarantine.** If B dies, A is not automatically quarantined. A receives an error for the specific tool call and can proceed with its remaining tools. The operator decides whether to quarantine A.

### 7.2 Supervision Model

Cortex Plane uses a **flat supervision model**, not Erlang-style trees:

- The **AgentLifecycleManager** is the single supervisor for all agents.
- Each agent is independent — no parent-child hierarchy at the lifecycle level.
- Subagent relationships are **per-job** (delegation in job payload), not persistent.
- The control plane monitors all agents equally; operator sets priority via `resource_limits`.

**Rationale:** Erlang-style supervision trees assume persistent parent-child relationships. Cortex Plane agents are ephemeral (k8s batch Jobs) and independently deployable. A flat model with per-job delegation is simpler and matches the architecture.

---

## 8. Configuration Model

### 8.1 Agent Resource Limits Extension

The existing `agent.resource_limits` JSONB is extended with circuit breaker and context budget config:

```jsonc
{
  // Existing
  "maxTokens": 200000,
  "maxTurns": 25,
  "maxTools": 40,
  "skillTokenBudget": 8000,

  // New: context budget
  "contextBudget": {
    "maxSystemPromptChars": 8000,
    "maxIdentityChars": 4000,
    "maxMemoryChars": 4000,
    "maxToolDefinitionsChars": 16000,
    "maxTotalContextChars": 120000,
    "reservedForConversation": 40000
  },

  // New: circuit breaker
  "circuitBreaker": {
    "maxConsecutiveFailures": 3,
    "maxToolErrorsPerJob": 10,
    "maxLlmRetriesPerJob": 5,
    "tokenBudgetPerJob": 500000,
    "tokenBudgetPerSession": 2000000,
    "toolCallRateLimit": { "maxCalls": 50, "windowSeconds": 300 },
    "llmCallRateLimit": { "maxCalls": 20, "windowSeconds": 300 }
  },

  // New: checkpoint
  "checkpointIntervalMs": 60000,
  "maxCheckpointSizeBytes": 262144,
  "checkpointRetentionCount": 10
}
```

### 8.2 Default Values

All new config fields have sensible defaults. Agents with no explicit `contextBudget` or `circuitBreaker` config use system defaults defined in `packages/control-plane/src/lifecycle/defaults.ts`.

---

## 9. API Surface

### 9.1 New Endpoints

```
POST   /agents/:agentId/quarantine
  Body: { reason: string }
  Response: 200 { state: "QUARANTINED", reason }
  Auth: operator or admin

POST   /agents/:agentId/release
  Body: { resetCircuitBreaker?: boolean }
  Response: 200 { state: "READY" }
  Auth: operator or admin

POST   /agents/:agentId/boot
  Query: ?mode=safe
  Body: { jobId?: string }
  Response: 200 { state: "BOOTING" | "SAFE_MODE" }
  Auth: operator or admin

POST   /agents/:agentId/rollback
  Body: { checkpointId: string, restoreContext?: boolean }
  Response: 200 { state: "QUARANTINED", restoredFrom: checkpointId }
  Auth: admin only

GET    /agents/:agentId/health
  Response: 200 {
    lifecycleState, healthStatus, circuitBreaker: { tripped, reason },
    lastHeartbeat, lastCheckpoint, tokenBudgetRemaining
  }
  Auth: operator or admin

GET    /agents/:agentId/checkpoints
  Query: ?limit=10&offset=0
  Response: 200 { checkpoints: [...], total }
  Auth: operator or admin

POST   /agents/:agentId/checkpoints
  Body: { label?: string }
  Response: 201 { id, agentId, label, createdAt }
  Auth: operator or admin
```

### 9.2 Modified Endpoints

```
GET /agents/:agentId
  Response: adds `lifecycleState`, `healthStatus`, `circuitBreakerState` fields

GET /health
  Response: adds `agents: { total, healthy, degraded, quarantined }` section
```

---

## 10. Observability

### 10.1 Metrics (Prometheus)

| Metric | Type | Labels |
|--------|------|--------|
| `cortex_agent_state_transitions_total` | Counter | `agent_id`, `from`, `to` |
| `cortex_agent_circuit_breaker_trips_total` | Counter | `agent_id`, `reason` |
| `cortex_agent_context_budget_exceeded_total` | Counter | `agent_id`, `component` |
| `cortex_agent_output_validation_rejected_total` | Counter | `agent_id`, `content_type` |
| `cortex_agent_checkpoint_writes_total` | Counter | `agent_id`, `trigger` |
| `cortex_agent_quarantine_duration_seconds` | Histogram | `agent_id` |
| `cortex_agent_token_usage_total` | Counter | `agent_id`, `job_id` |
| `cortex_agent_health_probe_duration_seconds` | Histogram | `agent_id` |

### 10.2 Structured Logs

All lifecycle events emit structured JSON logs with:
- `event`: lifecycle event name (e.g., `agent.state_transition`, `agent.circuit_breaker.tripped`)
- `agentId`, `jobId`: identifiers
- `from`, `to`: state transition
- `reason`: human-readable explanation
- `metadata`: event-specific data

### 10.3 OpenTelemetry Spans

Extend existing span attributes (from `CortexAttributes`) with:
- `cortex.agent.lifecycle_state`
- `cortex.agent.circuit_breaker_state`
- `cortex.agent.context_budget_usage_pct`
- `cortex.agent.token_budget_remaining`

---

## 11. Epic Breakdown — Implementation Tickets

### #266-T1: Extend state machine — add DEGRADED, QUARANTINED, SAFE_MODE [Size: M]

**Scope:**
- `packages/control-plane/src/lifecycle/state-machine.ts` — add new states + transitions
- `packages/control-plane/src/lifecycle/__tests__/state-machine.test.ts` — update tests

**Changes:**
- Add `DEGRADED`, `QUARANTINED`, `SAFE_MODE` to `AgentLifecycleState` union.
- Update `VALID_TRANSITIONS` map with new transition rules per §3.3.
- Add `isDegraded`, `isQuarantined`, `isSafeMode` getters to `AgentLifecycleStateMachine`.
- Update `isReady` to return true for `DEGRADED` (still serving, just impaired).
- Preserve backward compat: existing 6-state transitions remain valid.

**API contract:** No new routes (internal state machine only).

**Acceptance criteria:**
- [ ] `EXECUTING → DEGRADED` transition succeeds.
- [ ] `EXECUTING → QUARANTINED` transition succeeds.
- [ ] `QUARANTINED → DRAINING` transition succeeds.
- [ ] `QUARANTINED → EXECUTING` is rejected (must go through DRAINING → re-boot).
- [ ] `SAFE_MODE → READY` transition succeeds.
- [ ] All existing 6-state tests pass unchanged.
- [ ] `pnpm test` and `pnpm run typecheck` pass.

**Dependencies:** None (first ticket).

---

### #266-T2: Context budget enforcement [Size: M]

**Scope:**
- `packages/control-plane/src/lifecycle/context-budget.ts` (new)
- `packages/control-plane/src/lifecycle/__tests__/context-budget.test.ts` (new)
- `packages/control-plane/src/lifecycle/defaults.ts` (new — shared defaults)
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — integrate validation

**Functions:**
- `validateContextBudget(context, config): BudgetResult` — validates all context components against budget.
- `truncateComponent(content, maxChars): { result: string; truncated: boolean }` — safe truncation with marker.
- `DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig` — system defaults.
- Integration: call `validateContextBudget()` in `buildExecutionTask()` after assembling context. On failure: log `context_budget_exceeded`, refuse to dispatch job, transition job to FAILED.

**API contract:**
```typescript
interface ContextBudgetConfig {
  maxSystemPromptChars: number
  maxIdentityChars: number
  maxMemoryChars: number
  maxToolDefinitionsChars: number
  maxTotalContextChars: number
  reservedForConversation: number
}

interface BudgetResult {
  valid: boolean
  components: Record<string, { chars: number; max: number; truncated: boolean }>
  totalChars: number
  warnings: string[]
}
```

**Acceptance criteria:**
- [ ] Context within budget: `valid = true`, no truncation.
- [ ] System prompt exceeding max: truncated with `[TRUNCATED]` marker, warning logged.
- [ ] Total context exceeding max: `valid = false`, job refused.
- [ ] Missing `contextBudget` config: system defaults applied.
- [ ] Integration test: agent with oversized IDENTITY gets truncated context, job still executes.
- [ ] `pnpm test` passes.

**Dependencies:** None (parallel with T1).

---

### #266-T3: Output validation — memory writes and checkpoint integrity [Size: S]

**Scope:**
- `packages/control-plane/src/lifecycle/output-validator.ts` (new)
- `packages/control-plane/src/lifecycle/__tests__/output-validator.test.ts` (new)
- `packages/control-plane/src/lifecycle/hydration.ts` — add checkpoint CRC validation on read

**Functions:**
- `validateMemoryWrite(content, maxChars): OutputValidationResult`
- `validateCheckpointWrite(data, maxBytes): OutputValidationResult`
- `computeCheckpointCrc(data): number` — CRC32 computation for integrity.
- `verifyCheckpointIntegrity(data, expectedCrc): boolean`

**API contract:**
```typescript
interface OutputValidationResult {
  valid: boolean
  sanitized: string | Record<string, unknown>
  violations: string[]
}
```

**Acceptance criteria:**
- [ ] Memory write within limits: accepted, no modification.
- [ ] Memory write exceeding 8,000 chars: rejected with `memory_write_rejected` event.
- [ ] Checkpoint within 256 KB: accepted with CRC32 computed.
- [ ] Checkpoint exceeding max: rejected, previous checkpoint preserved.
- [ ] Checkpoint with mismatched CRC on read: logged as `checkpoint_corruption_detected`, DEGRADED transition.
- [ ] `pnpm test` passes.

**Dependencies:** None (parallel with T1, T2).

---

### #266-T4: Agent circuit breaker service [Size: L]

**Scope:**
- `packages/control-plane/src/lifecycle/agent-circuit-breaker.ts` (new)
- `packages/control-plane/src/lifecycle/__tests__/agent-circuit-breaker.test.ts` (new)
- `packages/control-plane/src/lifecycle/defaults.ts` — add circuit breaker defaults

**Functions:**
- `AgentCircuitBreaker` class per §5.3.
- `DEFAULT_AGENT_CIRCUIT_BREAKER_CONFIG` — sensible defaults.
- Methods: `recordJobSuccess()`, `recordJobFailure()`, `recordToolCall()`, `recordLlmCall()`, `recordTokenUsage()`, `recordToolError()`, `shouldQuarantine()`, `shouldAbortJob()`, `reset()`.

**API contract:** See §5.3.

**Acceptance criteria:**
- [ ] 3 consecutive job failures → `shouldQuarantine()` returns `{ quarantine: true }`.
- [ ] Job success resets consecutive failure count.
- [ ] 10 tool errors in one job → `shouldAbortJob()` returns `{ abort: true, reason: "tool_errors" }`.
- [ ] 500K tokens used in one job → `shouldAbortJob()` returns `{ abort: true, reason: "token_budget" }`.
- [ ] 50 tool calls in 5 minutes → `recordToolCall()` returns `false`.
- [ ] 20 LLM calls in 5 minutes → `recordLlmCall()` returns `false`.
- [ ] `reset()` clears all counters and untrips.
- [ ] All thresholds are configurable via `AgentCircuitBreakerConfig`.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T1 (needs QUARANTINED state).

---

### #266-T5: Wire circuit breaker into agent-execute [Size: M]

**Scope:**
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — integrate circuit breaker
- `packages/control-plane/src/lifecycle/manager.ts` — add quarantine transition

**Changes:**
- In `createAgentExecuteTask`: instantiate `AgentCircuitBreaker` from `agent.resource_limits.circuitBreaker`.
- Before each tool call: check `recordToolCall()`. If false, abort job with `tool_rate_limit_exceeded`.
- Before each LLM call: check `recordLlmCall()`. If false, abort job with `llm_rate_limit_exceeded`.
- After each output event with token usage: check `recordTokenUsage()`. If false, cancel execution handle.
- On job completion: call `recordJobSuccess()`.
- On job failure: call `recordJobFailure()`, then check `shouldQuarantine()`. If true, transition agent to QUARANTINED via `AgentLifecycleManager`.
- In `AgentLifecycleManager.quarantine(agentId, reason)`: new method that transitions state, cancels running job, logs event.

**API contract:** No new routes (internal wiring).

**Acceptance criteria:**
- [ ] Agent with 3 consecutive failed jobs is automatically quarantined.
- [ ] Agent with token budget exceeded mid-job: execution cancelled, job FAILED.
- [ ] Tool call rate limit exceeded: tool call skipped, error returned to LLM.
- [ ] Successful job resets failure counter.
- [ ] Quarantined agent: new jobs are rejected with 409 status.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T1, #266-T4.

---

### #266-T6: DB migration — agent_checkpoint table [Size: S]

**Scope:**
- `packages/control-plane/migrations/016_agent_checkpoint.up.sql` (new)
- `packages/control-plane/migrations/016_agent_checkpoint.down.sql` (new)
- `packages/control-plane/src/db/types.ts` — add Kysely types for `agent_checkpoint`

**Data model changes:**
- `agent_checkpoint` table per §6.1.
- Index on `(agent_id, created_at DESC)`.
- Foreign key to `agent(id)` with CASCADE delete.
- Foreign key to `job(id)` with SET NULL delete.

**Acceptance criteria:**
- [ ] Migration runs forward and backward without error.
- [ ] Kysely types compile.
- [ ] Cascade: deleting an agent removes its checkpoints.
- [ ] `pnpm run typecheck` passes.

**Dependencies:** None (parallel with T1–T4).

---

### #266-T7: Checkpoint CRUD + rollback API [Size: M]

**Scope:**
- `packages/control-plane/src/routes/agent-checkpoints.ts` (new)
- `packages/control-plane/src/routes/__tests__/agent-checkpoints.test.ts` (new)
- `packages/control-plane/src/app.ts` — register routes

**Routes per §9.1:**
- `GET /agents/:agentId/checkpoints` — list checkpoints.
- `POST /agents/:agentId/checkpoints` — create manual checkpoint.
- `POST /agents/:agentId/rollback` — restore from checkpoint.

**Acceptance criteria:**
- [ ] `GET` returns paginated checkpoints sorted by `created_at DESC`.
- [ ] `POST` creates checkpoint with CRC32 integrity.
- [ ] Rollback quarantines agent, restores checkpoint, logs event.
- [ ] Rollback with invalid checkpoint ID returns 404.
- [ ] Rollback with CRC mismatch returns 409.
- [ ] Routes require operator (GET, POST checkpoint) or admin (rollback) role.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T6.

---

### #266-T8: Health probe + agent health API [Size: M]

**Scope:**
- `packages/control-plane/src/lifecycle/health-probe.ts` (new)
- `packages/control-plane/src/lifecycle/__tests__/health-probe.test.ts` (new)
- `packages/control-plane/src/routes/agents.ts` — add `GET /agents/:agentId/health`
- `packages/control-plane/src/lifecycle/manager.ts` — wire probe into monitoring loop

**Functions:**
- `probeAgentHealth(agentId, deps): Promise<HealthProbeResult>` per §6.4.
- Schedule: run probe every 60s for EXECUTING, 300s for READY, skip for QUARANTINED/TERMINATED.
- Probe result feeds DEGRADED transition (subsystem failure) and dashboard display.

**API contract:**
```
GET /agents/:agentId/health
Response: {
  agentId, lifecycleState, healthStatus,
  circuitBreaker: { state, consecutiveFailures, tripped, tripReason },
  lastHeartbeat, lastCheckpoint,
  tokenBudget: { used, remaining, limit },
  subsystems: { qdrant, db, mcp }
}
```

**Acceptance criteria:**
- [ ] Healthy agent: all subsystems report OK.
- [ ] Agent with Qdrant unavailable: `subsystems.qdrant = "DEGRADED"`, overall `healthStatus = "DEGRADED"`.
- [ ] Agent with tripped circuit breaker: `circuitBreaker.tripped = true`.
- [ ] Probe runs on schedule (mocked timer in tests).
- [ ] API returns 404 for unknown agent.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T1, #266-T4, #266-T5.

---

### #266-T9: Quarantine + release + safe-mode API routes [Size: M]

**Scope:**
- `packages/control-plane/src/routes/agent-lifecycle.ts` (new)
- `packages/control-plane/src/routes/__tests__/agent-lifecycle.test.ts` (new)
- `packages/control-plane/src/app.ts` — register routes
- `packages/control-plane/src/lifecycle/manager.ts` — add `quarantine()`, `release()`, `bootSafeMode()` methods

**Routes per §9.1:**
- `POST /agents/:agentId/quarantine` — freeze agent.
- `POST /agents/:agentId/release` — release from quarantine.
- `POST /agents/:agentId/boot?mode=safe` — boot in safe mode.

**Acceptance criteria:**
- [ ] Quarantine transitions EXECUTING agent to QUARANTINED, cancels running job.
- [ ] Quarantine on already-quarantined agent returns 409.
- [ ] Release transitions QUARANTINED → DRAINING (triggers re-boot cycle).
- [ ] Release with `resetCircuitBreaker: true` resets agent circuit breaker counters.
- [ ] Safe-mode boot creates agent with no tools, no memory, minimal system prompt.
- [ ] All routes require operator or admin role.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T1, #266-T5.

---

### #266-T10: Observability — metrics + structured lifecycle logs [Size: S]

**Scope:**
- `packages/control-plane/src/lifecycle/metrics.ts` (new)
- `packages/shared/src/tracing/attributes.ts` — extend `CortexAttributes`
- `packages/control-plane/src/lifecycle/manager.ts` — emit metrics on transitions

**Changes:**
- Prometheus counters/histograms per §10.1.
- Structured log helper that emits JSON lifecycle events per §10.2.
- Extend `CortexAttributes` with new span attributes per §10.3.
- Wire into `AgentLifecycleStateMachine.onTransition()` listener.

**Acceptance criteria:**
- [ ] State transition emits `cortex_agent_state_transitions_total` counter.
- [ ] Circuit breaker trip emits `cortex_agent_circuit_breaker_trips_total` counter.
- [ ] Structured log includes `event`, `agentId`, `from`, `to`, `reason`.
- [ ] `pnpm test` passes.

**Dependencies:** #266-T1, #266-T4.

---

## 12. Dependency Graph

```
T1 (state machine)
├── T4 (agent circuit breaker)
│   └── T5 (wire into agent-execute)
│       ├── T8 (health probe + API)
│       └── T9 (quarantine/release/safe-mode API)
├── T10 (observability)
T2 (context budget)          ← parallel with T1
T3 (output validation)       ← parallel with T1, T2
T6 (checkpoint migration)    ← parallel with T1–T4
└── T7 (checkpoint CRUD + rollback API)
```

**Critical path:** T1 → T4 → T5 → T9 (enables automatic quarantine + operator recovery)

**Parallelizable:**
- T1, T2, T3, T6 can all start simultaneously.
- T4 and T10 start after T1.
- T7 starts after T6.
- T8 and T9 start after T5.

---

## 13. Answers to Spike Questions (#266)

| # | Question | Answer |
|---|----------|--------|
| 1 | What states beyond BOOTING/ACTIVE/PAUSED? | DEGRADED, QUARANTINED, SAFE_MODE (§3.1) |
| 2 | State transition rules? | §3.3 — formalized in `VALID_TRANSITIONS` map |
| 3 | Who decides state changes? | Platform (automatic) for DEGRADED/QUARANTINED; Operator (manual) for release/safe-mode (§3.4) |
| 4 | Context budget enforcement? | Platform-enforced hard caps per component (§4.1) |
| 5 | Output validation? | Size + format validation before store (§4.2) |
| 6 | Immutable core config? | Agent cannot write to `agent` table; tools have no write path (§4.3) |
| 7 | Max consecutive failures? | Configurable, default 3 → auto-quarantine (§5.2) |
| 8 | Token budget per session? | Hard cutoff, default 2M tokens/session (§5.2) |
| 9 | Tool call rate limiting? | Sliding window, default 50 calls/5min (§5.2) |
| 10 | LLM call timeout? | Initial 2min, backoff 1.5×, max 5min, 3 retries (§5.4) |
| 11 | Checkpointing? | Step completion + periodic 60s + drain + manual (§6.1) |
| 12 | Rollback? | `POST /agents/:id/rollback` restores from versioned checkpoint (§6.2) |
| 13 | Safe mode? | Boot with no tools/memory for debugging (§6.3) |
| 14 | Health checks? | Heartbeat (15s) + application probe (60s) (§6.4) |
| 15 | Agent A depends on B, B dies? | A receives tool error, no cascading quarantine (§7.1) |
| 16 | Supervision trees? | Flat model — AgentLifecycleManager supervises all equally (§7.2) |
