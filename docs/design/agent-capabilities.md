# Agent Capability Model — Design Document

**Issue:** #264
**Status:** Proposed
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-03

---

## 1. Problem Statement

Cortex Plane's current capability model is implicit:

- `mcp_server.agent_scope` is a coarse array of agent IDs on the server — no per-tool granularity.
- `agent.skill_config.{allowedTools,deniedTools}` accepts glob strings but has no persistent binding table.
- There are no permission boundaries — any agent that has scope on an MCP server gets every tool from it.
- Subagent capability inheritance is undefined.
- The approval system (#212) operates at the job level, not per-tool.
- The operator cannot see, from a single surface, what an agent can do.

This design replaces the implicit model with an explicit, auditable **capability binding** system.

---

## 2. Design Principles

1. **Explicit over implicit.** Every tool an agent can invoke must be traceable to a binding row.
2. **Deny by default.** An agent with zero bindings has zero tools.
3. **Narrowing only.** Subagents can have fewer capabilities than their parent, never more.
4. **PostgreSQL is the source of truth.** No in-memory-only permissions.
5. **Operator visibility.** The dashboard shows the effective tool set for any agent at any time.
6. **Fail closed.** If capability resolution encounters an error, the tool is unavailable — not silently allowed.

---

## 3. Capability Binding Data Model

### 3.1 New Table: `agent_tool_binding`

Replaces the implicit `mcp_server.agent_scope` array and `skill_config.allowedTools` for MCP tools. Each row grants one agent access to one tool with optional constraints.

```sql
CREATE TYPE tool_approval_policy AS ENUM ('auto', 'always_approve', 'conditional');

CREATE TABLE agent_tool_binding (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  tool_ref      TEXT NOT NULL,            -- qualified MCP name ('mcp:slack:chat_postMessage')
                                          -- or built-in name ('web_search', 'memory_query')
  approval_policy  tool_approval_policy NOT NULL DEFAULT 'auto',
  approval_condition JSONB,               -- for 'conditional': e.g. {"field":"recipient","match":"external"}
  rate_limit    JSONB,                    -- e.g. {"max_calls": 100, "window_seconds": 3600}
  cost_budget   JSONB,                    -- e.g. {"max_usd": 10.0, "window_seconds": 86400}
  data_scope    JSONB,                    -- e.g. {"calendars": ["primary"], "read_only": true}
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, tool_ref)
);

CREATE INDEX idx_atb_agent ON agent_tool_binding(agent_id) WHERE enabled = true;
```

**Key decisions:**

- **Binding granularity is per-tool**, not per-server. An operator binds `mcp:google-calendar:calendar_read` separately from `mcp:google-calendar:calendar_write`.
- **`tool_ref` is a qualified MCP name or built-in name.** This unifies MCP tools and built-in tools (web_search, memory_query, etc.) under one binding model.
- **Glob patterns are NOT stored in the binding table.** Each row is an explicit, auditable binding. Bulk-binding UX can create many rows at once, but the DB is always explicit.
- **`mcp_server.agent_scope` is deprecated** once this table is populated. Migration path: expand existing `agent_scope` arrays into `agent_tool_binding` rows for all tools on those servers.

### 3.2 New Table: `tool_category`

Optional grouping for dashboard UX. Not used in authorization logic.

```sql
CREATE TABLE tool_category (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL UNIQUE,        -- 'communication', 'data', 'actions', 'development'
  icon  TEXT,                        -- optional icon identifier
  description TEXT
);

CREATE TABLE tool_category_membership (
  tool_ref     TEXT NOT NULL,
  category_id  UUID NOT NULL REFERENCES tool_category(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_ref, category_id)
);
```

### 3.3 New Table: `capability_audit_log`

Every binding mutation and every tool invocation is logged.

```sql
CREATE TABLE capability_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         UUID NOT NULL,
  tool_ref         TEXT NOT NULL,
  event_type       TEXT NOT NULL,           -- 'binding_created', 'binding_removed', 'tool_invoked',
                                            -- 'tool_denied', 'rate_limited', 'approval_required'
  actor_user_id    UUID,                    -- who made the change / triggered invocation
  job_id           UUID,                    -- if tool_invoked/denied/rate_limited
  details          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cal_agent ON capability_audit_log(agent_id, created_at DESC);
CREATE INDEX idx_cal_tool ON capability_audit_log(tool_ref, created_at DESC);
```

### 3.4 Existing Table Changes

**`agent` table** — Add JSONB column for assembled effective capabilities snapshot:

```sql
ALTER TABLE agent ADD COLUMN effective_capabilities JSONB;
-- Populated by the CapabilityAssembler on binding change. Cached for fast reads.
-- Schema: { tools: [{ ref, approval_policy, rate_limit, ... }], assembled_at }
```

**`mcp_server` table** — `agent_scope` column becomes deprecated:

```sql
-- No immediate removal. Mark deprecated in code. Migration ticket handles cleanup.
COMMENT ON COLUMN mcp_server.agent_scope IS 'DEPRECATED: use agent_tool_binding instead';
```

---

## 4. Permission Scoping Model

### 4.1 Tool-Level Permissions

Permissions are expressed through the presence or absence of an `agent_tool_binding` row:

| Question | Answer |
|----------|--------|
| Can Agent A use `calendar_read`? | Iff `agent_tool_binding` row exists with `enabled = true` |
| Can Agent A use `calendar_write`? | Separate binding row required |
| Can Agent A use any tool from MCP server X? | One binding row per tool; no server-level wildcard |

### 4.2 Data-Level Permissions

The `data_scope` JSONB on `agent_tool_binding` carries tool-specific constraints:

```jsonc
// calendar_read binding for Agent "scheduler"
{
  "calendars": ["primary", "team-standup"],
  "read_only": true
}

// gmail_send binding for Agent "outreach"
{
  "allowed_recipients": ["*@company.com"],
  "blocked_recipients": ["ceo@company.com"]
}
```

Data scope is **injected into the tool call context** at execution time. The tool executor passes `data_scope` as a parameter alongside the user-provided input. MCP tools receive it as `_cortex_scope` in the input object; built-in tools check it in their handler.

### 4.3 Rate Limiting

Each binding can carry a `rate_limit` JSONB:

```jsonc
{ "max_calls": 100, "window_seconds": 3600 }
```

Enforcement uses a **sliding-window counter** in PostgreSQL:

```sql
-- Check: count invocations for this agent+tool in the window
SELECT count(*) FROM capability_audit_log
WHERE agent_id = $1 AND tool_ref = $2
  AND event_type = 'tool_invoked'
  AND created_at > now() - ($3 || ' seconds')::interval;
```

If the count exceeds `max_calls`, the tool invocation is denied and `tool_denied` + `rate_limited` events are logged.

### 4.4 Cost Budgets

Similar to rate limiting but on estimated cost:

```jsonc
{ "max_usd": 10.0, "window_seconds": 86400 }
```

Tool invocations that carry cost metadata (e.g., API calls with per-call pricing) are summed. Implementation deferred to a later ticket but the schema supports it now.

---

## 5. Context Assembly Algorithm

### 5.1 Current Flow (Before)

```
agent_execute.ts:
  1. Load agent.skill_config.{allowedTools, deniedTools}
  2. Resolve skills → merge constraints (intersection for allowed, union for denied)
  3. mcpToolRouter.resolveAll(agentId, allowedTools, deniedTools)
     → uses mcp_server.agent_scope + glob matching
  4. createAgentToolRegistry(agentConfig, { mcpRouter, ... })
     → registers built-in tools + webhook tools + MCP tools
  5. ToolRegistry.resolve(allowedTools, deniedTools) at LLM call time
```

### 5.2 New Flow (After)

```
agent_execute.ts:
  1. capabilityAssembler.resolveEffectiveTools(agentId)
     → Queries agent_tool_binding WHERE agent_id = $1 AND enabled = true
     → Joins mcp_server_tool for MCP refs to validate tool exists + server ACTIVE
     → Returns EffectiveTool[] with approval_policy, rate_limit, data_scope
  2. Apply skill constraints (narrowing only — intersection)
  3. capabilityAssembler.buildToolDefinitions(effectiveTools)
     → For MCP tools: createMcpToolDefinition() via tool-bridge
     → For built-in tools: look up in default registry
     → Wraps each tool.execute() with a CapabilityGuard:
        a. Rate limit check
        b. Approval policy check
        c. Data scope injection
        d. Audit logging
  4. Inject into ToolRegistry for the LLM call
  5. ToolRegistry now only contains exactly the tools the agent is allowed to use
     (no separate allowedTools/deniedTools filtering at LLM call time)
```

### 5.3 Tool Count Management

Too many tools degrade LLM performance. The assembler applies these heuristics:

1. **Hard cap:** Max 40 tools per LLM call (configurable in `agent.resource_limits.maxTools`).
2. **Priority ordering:** Tools are sorted by:
   - Explicit priority in `agent_tool_binding` (future column, default 0)
   - Category relevance (if job payload includes goal_type, prefer matching categories)
   - Recent usage frequency (from `capability_audit_log`)
3. **Progressive disclosure:** If tool count > cap, lower-priority tools are summarized in the system prompt rather than included as callable tools.

### 5.4 CapabilityAssembler Service

```typescript
// packages/control-plane/src/capabilities/assembler.ts

interface EffectiveTool {
  toolRef: string               // 'mcp:slack:chat_postMessage' or 'web_search'
  approvalPolicy: 'auto' | 'always_approve' | 'conditional'
  approvalCondition?: Record<string, unknown>
  rateLimit?: { maxCalls: number; windowSeconds: number }
  costBudget?: { maxUsd: number; windowSeconds: number }
  dataScope?: Record<string, unknown>
  toolDefinition: ToolDefinition  // resolved executable tool
}

class CapabilityAssembler {
  constructor(deps: {
    db: Kysely<Database>
    mcpClientPool: McpClientPool
    defaultRegistry: ToolRegistry
  })

  /** Resolve all effective tools for an agent. */
  resolveEffectiveTools(agentId: string): Promise<EffectiveTool[]>

  /** Build a guarded ToolRegistry from effective tools. */
  buildGuardedRegistry(
    effectiveTools: EffectiveTool[],
    executionContext: { agentId: string; jobId: string; userId: string }
  ): ToolRegistry

  /** Recompute and cache effective_capabilities on the agent row. */
  refreshAgentCapabilities(agentId: string): Promise<void>
}
```

---

## 6. Subagent Delegation Rules

### 6.1 Capability Inheritance Model

When an agent spawns a subagent, the subagent's capabilities are derived from the parent:

```
Subagent.effectiveTools = Parent.effectiveTools ∩ DelegationGrant
```

**Rules:**

1. **Default: empty set.** A subagent with no explicit delegation has zero tools.
2. **Delegation must be a subset.** The parent can only delegate tools it has. Attempting to delegate a tool the parent doesn't have is a no-op (logged as `delegation_denied`).
3. **Approval policies transfer.** If the parent's binding says `always_approve`, the subagent inherits that — it cannot downgrade to `auto`.
4. **Rate limits are shared.** The parent and subagent share the same rate limit window. This prevents circumventing limits by spawning subagents.

### 6.2 Data Model

Subagent delegation is expressed at job creation time in the job payload:

```jsonc
// POST /agents/:parentId/jobs
{
  "prompt": "...",
  "subagent": {
    "agentId": "sub-agent-uuid",
    "delegatedTools": ["mcp:google-calendar:calendar_read", "web_search"],
    "dataScopes": {
      "mcp:google-calendar:calendar_read": { "calendars": ["primary"] }
    }
  }
}
```

The `agent_execute` task validates the delegation grant against the parent's effective tools before executing the subagent.

### 6.3 Future: Subagent Binding Table

For persistent subagent relationships (not just per-job), a future table `agent_delegation` could formalize parent-child tool delegation. Deferred — current scope handles per-job delegation only.

---

## 7. Approval Gate Integration

### 7.1 Per-Tool Approval Policy

The existing approval system (ApprovalService, #212) operates at the job level. This design extends it to per-tool granularity:

| Policy | Behavior |
|--------|----------|
| `auto` | Tool executes immediately. No approval gate. |
| `always_approve` | Tool invocation pauses execution, creates an ApprovalRequest with `action_type = 'tool_invocation'`, waits for human decision. |
| `conditional` | Evaluates `approval_condition` JSONB against the tool input. If condition matches, behaves like `always_approve`; otherwise `auto`. |

### 7.2 Conditional Approval Examples

```jsonc
// gmail_send: approve if recipient is external
{
  "field": "to",
  "operator": "not_matches",
  "value": "*@company.com"
}

// http_request: approve if URL is not on allowlist
{
  "field": "url",
  "operator": "not_in",
  "value": ["https://api.internal.com/*"]
}
```

### 7.3 Integration with CapabilityGuard

The `CapabilityGuard` wraps each tool's `execute()` function:

```typescript
// packages/control-plane/src/capabilities/guard.ts

class CapabilityGuard {
  constructor(
    private tool: EffectiveTool,
    private approvalService: ApprovalService,
    private context: { agentId: string; jobId: string; userId: string },
    private db: Kysely<Database>,
  ) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    // 1. Rate limit check
    if (this.tool.rateLimit) {
      const count = await this.countRecentInvocations()
      if (count >= this.tool.rateLimit.maxCalls) {
        await this.logAudit('rate_limited', input)
        throw new ToolRateLimitError(this.tool.toolRef, this.tool.rateLimit)
      }
    }

    // 2. Approval policy check
    if (this.requiresApproval(input)) {
      const approval = await this.approvalService.createRequest({
        jobId: this.context.jobId,
        agentId: this.context.agentId,
        actionType: 'tool_invocation',
        actionSummary: `${this.tool.toolRef} invocation`,
        actionDetail: { tool_ref: this.tool.toolRef, input },
        riskLevel: 'P1',
      })
      if (!approval.autoApprovable) {
        throw new ToolApprovalRequiredError(this.tool.toolRef, approval.approvalRequestId)
      }
    }

    // 3. Data scope injection
    const scopedInput = this.tool.dataScope
      ? { ...input, _cortex_scope: this.tool.dataScope }
      : input

    // 4. Execute
    const result = await this.tool.toolDefinition.execute(scopedInput)

    // 5. Audit log
    await this.logAudit('tool_invoked', input)

    return result
  }
}
```

### 7.4 Resume Flow

When a tool invocation requires approval and the approval is granted:

1. ApprovalService transitions job back to `RUNNING`.
2. Job is re-enqueued via Graphile Worker.
3. On re-execution, the `CapabilityGuard` checks for an existing `APPROVED` approval request for the same tool invocation (matched by `action_detail.tool_ref` + `job_id`).
4. If found, the tool executes without re-prompting.

---

## 8. Dashboard UX for Managing Capabilities

### 8.1 Agent Capabilities Page

New route: `/agents/:id/capabilities`

Sections:
1. **Effective Tools Table** — All tools the agent can invoke, with approval policy, rate limit, data scope, and last-used timestamp.
2. **Bind Tool Form** — Autocomplete from `mcp_server_tool` catalog + built-in tool names. Set approval policy, rate limit, data scope.
3. **Bulk Bind** — Select an MCP server → checkbox all/some tools → bind with shared policy.
4. **Audit Log** — Filterable by tool, event type, time range.

### 8.2 API Surface

```
POST   /agents/:agentId/tool-bindings          -- Create binding
GET    /agents/:agentId/tool-bindings          -- List bindings (with effective status)
PUT    /agents/:agentId/tool-bindings/:id      -- Update binding
DELETE /agents/:agentId/tool-bindings/:id      -- Remove binding
GET    /agents/:agentId/effective-tools        -- Computed effective tool set
GET    /agents/:agentId/capability-audit       -- Audit log
POST   /agents/:agentId/tool-bindings/bulk     -- Bulk create from server
```

---

## 9. Migration Strategy

### Phase 1: Schema + Service (tickets #264-T1 through #264-T4)
- Add new tables.
- Build CapabilityAssembler and CapabilityGuard.
- Wire into agent_execute.ts alongside existing flow.
- Feature-flagged: `CAPABILITY_MODEL_V2=true` enables new path.

### Phase 2: Migration + Deprecation (tickets #264-T5 through #264-T6)
- Migrate `mcp_server.agent_scope` → `agent_tool_binding` rows.
- Migrate `skill_config.allowedTools` → `agent_tool_binding` rows.
- Deprecate old columns with warnings.

### Phase 3: Dashboard + Cleanup (tickets #264-T7 through #264-T8)
- Build dashboard capabilities page.
- Remove deprecated columns and old code paths.

---

## 10. Epic Breakdown — Implementation Tickets

### #264-T1: DB migration — agent_tool_binding + capability_audit_log + tool_category [Size: M]

**Scope:**
- `packages/control-plane/migrations/018-agent-capability-model.sql`
- `packages/control-plane/src/db/types.ts` — add Kysely types for new tables

**Data model changes:**
- `tool_approval_policy` enum
- `agent_tool_binding` table with indexes
- `capability_audit_log` table with indexes
- `tool_category` + `tool_category_membership` tables
- `ALTER TABLE agent ADD COLUMN effective_capabilities JSONB`
- `COMMENT ON COLUMN mcp_server.agent_scope` deprecation marker

**API contract:** N/A (schema only)

**Acceptance criteria:**
- [ ] Migration runs forward and backward (both up and down) without error on a DB with existing data.
- [ ] `agent_tool_binding` enforces UNIQUE(agent_id, tool_ref).
- [ ] Cascade delete: removing an agent removes its bindings.
- [ ] Kysely types compile and match the SQL schema.
- [ ] `pnpm run typecheck` passes.

**Dependencies:** None (first ticket).

---

### #264-T2: CapabilityAssembler service — resolve effective tools [Size: L]

**Scope:**
- `packages/control-plane/src/capabilities/assembler.ts` (new)
- `packages/control-plane/src/capabilities/types.ts` (new)
- `packages/control-plane/src/capabilities/__tests__/assembler.test.ts` (new)

**Functions:**
- `resolveEffectiveTools(agentId: string): Promise<EffectiveTool[]>`
  - Query `agent_tool_binding` WHERE agent_id AND enabled.
  - For MCP tool_refs: join `mcp_server_tool` + `mcp_server` to validate existence and ACTIVE status.
  - For built-in tool_refs: validate against known built-in names.
  - Return `EffectiveTool[]` with all binding metadata.
- `buildToolDefinitions(effectiveTools: EffectiveTool[]): ToolDefinition[]`
  - For MCP tools: use `createMcpToolDefinition()` from tool-bridge.
  - For built-in tools: look up in createDefaultToolRegistry().
- `refreshAgentCapabilities(agentId: string): Promise<void>`
  - Recompute effective tools → serialize to `agent.effective_capabilities` JSONB.

**API contract:**
```typescript
interface EffectiveTool {
  toolRef: string
  bindingId: string
  approvalPolicy: 'auto' | 'always_approve' | 'conditional'
  approvalCondition?: Record<string, unknown>
  rateLimit?: { maxCalls: number; windowSeconds: number }
  costBudget?: { maxUsd: number; windowSeconds: number }
  dataScope?: Record<string, unknown>
  toolDefinition: ToolDefinition
  mcpServer?: { id: string; slug: string; name: string }
}
```

**Acceptance criteria:**
- [ ] Agent with 3 bindings (1 MCP, 1 built-in, 1 disabled) resolves to exactly 2 effective tools.
- [ ] MCP tool bound to a DISABLED server is excluded.
- [ ] MCP tool bound to a non-existent tool_ref is excluded (logged as warning).
- [ ] Built-in tool with unknown name is excluded (logged as warning).
- [ ] `refreshAgentCapabilities()` writes the correct JSONB to `agent.effective_capabilities`.
- [ ] All tests pass with `pnpm test`.

**Dependencies:** #264-T1

---

### #264-T3: CapabilityGuard — rate limiting, approval gates, data scope injection [Size: L]

**Scope:**
- `packages/control-plane/src/capabilities/guard.ts` (new)
- `packages/control-plane/src/capabilities/errors.ts` (new)
- `packages/control-plane/src/capabilities/__tests__/guard.test.ts` (new)

**Functions:**
- `CapabilityGuard.wrap(tool: EffectiveTool, context): ToolDefinition`
  - Returns a new ToolDefinition whose `execute()` is guarded.
- Rate limit check: count `tool_invoked` events in `capability_audit_log` within window.
- Approval check: evaluate policy + conditional against input → create ApprovalRequest if needed.
- Data scope injection: merge `_cortex_scope` into input.
- Audit: write `tool_invoked`, `tool_denied`, `rate_limited`, `approval_required` events.

**API contract:**
```typescript
class CapabilityGuard {
  static wrap(
    tool: EffectiveTool,
    context: { agentId: string; jobId: string; userId: string },
    deps: { db: Kysely<Database>; approvalService?: ApprovalService }
  ): ToolDefinition
}

class ToolRateLimitError extends Error {
  constructor(toolRef: string, limit: { maxCalls: number; windowSeconds: number })
}

class ToolApprovalRequiredError extends Error {
  approvalRequestId: string
  constructor(toolRef: string, approvalRequestId: string)
}
```

**Acceptance criteria:**
- [ ] Tool with `rate_limit: { maxCalls: 2, windowSeconds: 60 }` succeeds twice, fails on third call within 60s.
- [ ] Tool with `always_approve` policy creates an ApprovalRequest and throws `ToolApprovalRequiredError`.
- [ ] Tool with `conditional` policy + matching input creates an ApprovalRequest.
- [ ] Tool with `conditional` policy + non-matching input executes immediately.
- [ ] Tool with `data_scope` passes `_cortex_scope` in the input to the underlying execute().
- [ ] All guard actions write to `capability_audit_log`.
- [ ] Rate limit query uses an index scan (EXPLAIN ANALYZE in test).

**Dependencies:** #264-T1, #264-T2

---

### #264-T4: Wire CapabilityAssembler into agent_execute.ts [Size: M]

**Scope:**
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — modify execution flow
- `packages/control-plane/src/backends/tool-executor.ts` — modify `createAgentToolRegistry`
- `packages/control-plane/src/capabilities/index.ts` (new barrel export)

**Changes:**
- In `createAgentExecuteTask` deps: add `capabilityAssembler?: CapabilityAssembler`.
- Feature flag check: `process.env.CAPABILITY_MODEL_V2 === 'true'`.
- When enabled:
  1. Replace `mcpToolRouter.resolveAll()` + `createAgentToolRegistry()` with `capabilityAssembler.resolveEffectiveTools()` + `buildGuardedRegistry()`.
  2. Remove `allowedTools`/`deniedTools` from ExecutionTask constraints (tools are pre-filtered).
  3. Pass guarded registry to `backend.executeTask(task, guardedRegistry)`.
- When disabled: existing flow unchanged.

**API contract:** No new routes. Internal wiring only.

**Acceptance criteria:**
- [ ] With `CAPABILITY_MODEL_V2=false`: existing tests pass unchanged.
- [ ] With `CAPABILITY_MODEL_V2=true`: agent with 2 bound tools sees exactly those 2 tools in LLM call.
- [ ] Agent with 0 bindings and V2=true gets zero tools (empty tools array in LLM call).
- [ ] CapabilityGuard wraps each tool — rate limit and approval checks fire during execution.
- [ ] Integration test: end-to-end job with V2 flag, bound tools, rate limit.
- [ ] `pnpm test` and `pnpm run typecheck` pass.

**Dependencies:** #264-T2, #264-T3

---

### #264-T5: Agent tool binding CRUD routes [Size: M]

**Scope:**
- `packages/control-plane/src/routes/agent-tool-bindings.ts` (new)
- `packages/control-plane/src/routes/agent-tool-bindings.test.ts` (new)
- `packages/control-plane/src/app.ts` — register routes

**Routes:**

```
POST   /agents/:agentId/tool-bindings
  Body: { toolRef, approvalPolicy?, approvalCondition?, rateLimit?, costBudget?, dataScope? }
  Response: 201 { id, agentId, toolRef, ... }

GET    /agents/:agentId/tool-bindings
  Query: ?enabled=true&category=communication
  Response: 200 { bindings: [...], total }

PUT    /agents/:agentId/tool-bindings/:bindingId
  Body: { approvalPolicy?, rateLimit?, dataScope?, enabled? }
  Response: 200 { ...updated binding }

DELETE /agents/:agentId/tool-bindings/:bindingId
  Response: 204

POST   /agents/:agentId/tool-bindings/bulk
  Body: { mcpServerId, toolRefs?: string[], approvalPolicy? }
  Response: 201 { created: number, bindings: [...] }

GET    /agents/:agentId/effective-tools
  Response: 200 { tools: EffectiveTool[], assembledAt }

GET    /agents/:agentId/capability-audit
  Query: ?toolRef=web_search&eventType=tool_invoked&limit=50&offset=0
  Response: 200 { entries: [...], total }
```

**Acceptance criteria:**
- [ ] POST creates binding and writes `binding_created` to capability_audit_log.
- [ ] POST with duplicate (agentId, toolRef) returns 409 Conflict.
- [ ] POST validates toolRef exists (MCP tool in catalog or known built-in).
- [ ] DELETE writes `binding_removed` to capability_audit_log.
- [ ] GET effective-tools returns computed result (not just raw bindings).
- [ ] Bulk bind from MCP server creates N bindings in one transaction.
- [ ] All routes require operator or admin role.
- [ ] `pnpm test` passes.

**Dependencies:** #264-T1, #264-T2

---

### #264-T6: Migrate agent_scope → agent_tool_binding [Size: S]

**Scope:**
- `packages/control-plane/migrations/019-migrate-agent-scope.sql`
- `packages/control-plane/scripts/migrate-agent-scope.ts` (one-shot script)

**Changes:**
- For each `mcp_server` with non-empty `agent_scope`:
  - For each agent_id in `agent_scope`:
    - For each `mcp_server_tool` on that server:
      - INSERT INTO `agent_tool_binding` (agent_id, tool_ref = qualified_name, approval_policy = 'auto').
      - ON CONFLICT DO NOTHING (idempotent).
- For each agent with `skill_config.allowedTools`:
  - INSERT bindings for each tool name.
- Set `mcp_server.agent_scope = '{}'` after migration.

**Acceptance criteria:**
- [ ] Migration is idempotent (safe to run multiple times).
- [ ] After migration, `agent_tool_binding` has the same effective tool set as the old model.
- [ ] `mcp_server.agent_scope` is emptied.
- [ ] Agents that had `skill_config.allowedTools` now have equivalent bindings.
- [ ] Existing tests pass (old code path still works, new bindings are additive).

**Dependencies:** #264-T1, #264-T5

---

### #264-T7: Subagent capability delegation [Size: M]

**Scope:**
- `packages/control-plane/src/capabilities/delegation.ts` (new)
- `packages/control-plane/src/capabilities/__tests__/delegation.test.ts` (new)
- `packages/control-plane/src/worker/tasks/agent-execute.ts` — subagent validation

**Functions:**
- `validateDelegation(parentAgentId, subagentAgentId, delegatedTools, db): Promise<ValidatedDelegation>`
  - Resolve parent's effective tools.
  - Intersect with requested `delegatedTools`.
  - Return validated set (with approval policies carried over).
  - Log `delegation_denied` for any tools the parent doesn't have.
- Integration point: when `job.payload.subagent` is present, validate before execution.

**API contract:**
```typescript
interface DelegationRequest {
  agentId: string              // subagent
  delegatedTools: string[]     // tool_refs
  dataScopes?: Record<string, Record<string, unknown>>
}

interface ValidatedDelegation {
  effectiveTools: EffectiveTool[]
  denied: string[]            // tool_refs parent doesn't have
  warnings: string[]          // e.g. "data_scope narrowed"
}
```

**Acceptance criteria:**
- [ ] Parent with tools [A, B, C] delegating [A, B, D] → subagent gets [A, B], D is denied+logged.
- [ ] Parent with `always_approve` on tool A → subagent inherits `always_approve`.
- [ ] Rate limits are shared: parent uses 1 of 3 calls → subagent has 2 remaining.
- [ ] Delegation with narrowed data_scope succeeds.
- [ ] Delegation with widened data_scope is rejected (logged as warning, parent scope used).

**Dependencies:** #264-T2, #264-T3

---

### #264-T8: Dashboard — agent capabilities page [Size: L]

**Scope:**
- `packages/dashboard/src/app/agents/[id]/capabilities/page.tsx` (new)
- `packages/dashboard/src/components/tool-binding-form.tsx` (new)
- `packages/dashboard/src/components/capability-audit-table.tsx` (new)
- `packages/dashboard/src/lib/api/tool-bindings.ts` (new)

**Sections:**
1. **Effective Tools Table** — tool name, server, approval policy, rate limit, data scope, last used.
2. **Bind Tool Form** — autocomplete from MCP catalog + built-ins, set policy/limits.
3. **Bulk Bind** — select MCP server → multi-select tools → shared policy.
4. **Audit Log** — filterable table with event type, time range, tool filter.
5. **Category Filter** — sidebar or chip filter by tool_category.

**Acceptance criteria:**
- [ ] Page loads and displays all effective tools for an agent.
- [ ] Operator can create a new binding via the form.
- [ ] Operator can bulk-bind all tools from an MCP server.
- [ ] Operator can modify approval policy and rate limits inline.
- [ ] Operator can remove a binding.
- [ ] Audit log shows recent activity with pagination.
- [ ] Page handles zero-binding state gracefully (empty state with CTA).

**Dependencies:** #264-T5

---

## 11. Dependency Graph

```
T1 (migration)
├── T2 (assembler)
│   ├── T3 (guard)
│   │   └── T4 (wire into agent-execute)
│   ├── T5 (CRUD routes)
│   │   ├── T6 (migrate agent_scope)
│   │   └── T8 (dashboard)
│   └── T7 (subagent delegation)
```

**Critical path:** T1 → T2 → T3 → T4 (enables V2 capability model in execution pipeline)

**Parallelizable:** T5 can start after T1+T2. T7 can start after T2+T3. T8 can start after T5.

---

## 12. Answers to Spike Questions

| # | Question | Answer |
|---|----------|--------|
| 1 | How does an operator bind tools? | `POST /agents/:id/tool-bindings` with explicit tool_ref per tool. |
| 2 | Server-level or tool-level binding? | **Tool-level.** Bulk-bind UX creates per-tool rows. |
| 3 | Dynamic binding? | Future: agent requests tool → approval flow → binding created. Not in initial scope. |
| 4 | Tool-level permissions? | Yes — separate `agent_tool_binding` row per tool. |
| 5 | Data-level permissions? | `data_scope` JSONB on each binding, injected as `_cortex_scope`. |
| 6 | Rate limiting per agent per tool? | `rate_limit` JSONB, enforced via sliding-window count on `capability_audit_log`. |
| 7 | Cost budgets? | Schema supports `cost_budget` JSONB. Enforcement deferred. |
| 8 | How are tools assembled? | `CapabilityAssembler.resolveEffectiveTools()` → `buildGuardedRegistry()`. |
| 9 | Too many tools? | Hard cap (40 default), priority ordering, progressive disclosure. |
| 10 | All tools or relevance filtering? | Only bound + enabled tools. No self-selection. |
| 11 | Tool categories? | `tool_category` table for dashboard grouping. Not authorization. |
| 12 | Subagent inheritance? | `Parent.effectiveTools ∩ DelegationGrant`. Default: empty set. |
| 13 | Explicit delegation? | Yes — `job.payload.subagent.delegatedTools` validated at execution. |
| 14 | Human approval before execution? | `approval_policy` on binding: `auto`, `always_approve`, `conditional`. |
| 15 | Approval system integration? | `CapabilityGuard` creates `ApprovalRequest` via existing `ApprovalService`. |
| 16 | Per-tool approval policy? | Yes — see Q14. Conditional evaluates input against `approval_condition` JSONB. |
