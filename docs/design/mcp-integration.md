# MCP Server Integration — Design Document

**Issue:** #262
**Status:** Implemented (Critical Path) / In Progress (Phase 2)
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-02
**Depends on:** MCP specification (2025-03-26), `@modelcontextprotocol/sdk`

---

## 1. Problem Statement

OpenClaw is limited to local CLI tools. MCP servers are the escape hatch — containerized, standardized, and there is a growing ecosystem. Cortex Plane can leverage MCP in ways OpenClaw cannot because it is k8s-native.

This design answers how Cortex Plane discovers, deploys, manages, and routes tool calls to MCP servers.

---

## 2. Architecture Overview

```
                  ┌────────────────────────────────────────────────────────┐
                  │               Control Plane (Fastify + Graphile)      │
                  │                                                        │
                  │  ┌────────────┐   ┌──────────────┐   ┌─────────────┐  │
     Operator ──► │  │ MCP Server │   │  Tool Router │   │   Health     │  │
     REST API     │  │ CRUD Routes│──►│  (resolve +  │   │  Supervisor  │  │
                  │  │ /mcp-servers│  │   cache)     │   │  (probes +   │  │
                  │  └────────────┘   └──────┬───────┘   │  circuit CB) │  │
                  │                          │           └──────┬──────┘  │
                  │                          ▼                  │         │
                  │                   ┌──────────────┐         │         │
                  │                   │  Tool Bridge │         │         │
                  │                   │  (adapt MCP  │         │         │
                  │                   │  → ToolDef)  │         │         │
                  │                   └──────┬───────┘         │         │
                  │                          │                 │         │
                  │                   ┌──────▼───────┐         │         │
                  │                   │ Client Pool  │◄────────┘         │
                  │                   │ (HTTP JSON-  │                   │
                  │                   │  RPC calls)  │                   │
                  │                   └──────┬───────┘                   │
                  └──────────────────────────┼───────────────────────────┘
                                             │
                           ┌─────────────────┼──────────────────┐
                           │                 │                  │
                    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
                    │ MCP Server  │   │ MCP Server  │   │ MCP Server  │
                    │ (GitHub)    │   │ (Slack)     │   │ (Filesystem)│
                    │ Streamable  │   │ Streamable  │   │ stdio       │
                    │ HTTP        │   │ HTTP        │   │ (future)    │
                    └─────────────┘   └─────────────┘   └─────────────┘
```

### Core Components

| Component | File | Responsibility |
|-----------|------|----------------|
| **McpServerRoutes** | `src/routes/mcp-servers.ts` | CRUD for server registry, connection encryption |
| **McpToolBridge** | `src/mcp/tool-bridge.ts` | Adapt `mcp_server_tool` rows into `ToolDefinition` objects |
| **McpToolRouter** | `src/mcp/tool-router.ts` | Name resolution (qualified/unqualified), conflict handling, TTL cache |
| **HttpMcpClientPool** | `src/mcp/client-pool.ts` | JSON-RPC `tools/call` over Streamable HTTP |
| **McpHealthSupervisor** | `src/mcp/health-supervisor.ts` | Periodic health probes, circuit breakers, DB status sync, SSE events |

### Wiring (app.ts)

```typescript
const mcpClientPool = new HttpMcpClientPool({ db })
const mcpToolRouter = new McpToolRouter({ db, clientPool: mcpClientPool })
const mcpHealthSupervisor = new McpHealthSupervisor({ db, sseManager })

// Injected into worker for agent execution
createWorker({ ..., mcpToolRouter })

// Decorated on Fastify for route handlers
app.decorate("mcpClientPool", mcpClientPool)
app.decorate("mcpToolRouter", mcpToolRouter)
app.decorate("mcpHealthSupervisor", mcpHealthSupervisor)
```

---

## 3. Registration / Discovery

### 3.1 How an Operator Adds an MCP Server

REST API — `POST /mcp-servers`:

```jsonc
{
  "name": "GitHub MCP",
  "slug": "github",                    // optional, auto-derived from name
  "transport": "streamable-http",      // enum: 'streamable-http' | 'stdio'
  "connection": {
    "url": "https://mcp-github.internal:8080/mcp",
    "headers": {                       // encrypted at rest via AES-256-GCM
      "Authorization": "Bearer ghp_..."
    }
  },
  "agent_scope": ["agent-uuid-1"],     // DEPRECATED → use agent_tool_binding
  "description": "GitHub API via MCP",
  "health_probe_interval_ms": 30000
}
```

**Decision: Database-backed registry over CRD.** API-first is simpler for v1. CRD-backed registration is a viable future extension but adds operator complexity (kubectl vs REST).

**Decision: No marketplace / auto-discovery in v1.** Operators register servers manually via API or dashboard. A curated catalog is deferred.

### 3.2 Connection Security

Sensitive connection headers (API keys, tokens) are encrypted at rest:
- `encrypt()` / `decrypt()` using AES-256-GCM via `credential-encryption.ts`
- Master key derived from `connectionEncryptionKey` passphrase
- Stored as `headers_enc` (serialized ciphertext); raw `headers` never persisted

### 3.3 Tool Catalog Sync

On server creation, the platform does NOT auto-sync tools. Tools are populated by:
1. Manual entry via future admin tooling, or
2. Planned: `POST /mcp-servers/:id/refresh` triggering an MCP `tools/list` call to populate `mcp_server_tool` rows

Each tool row stores the full MCP schema:

```sql
mcp_server_tool (
  id, mcp_server_id, name, qualified_name,
  description, input_schema JSONB, annotations JSONB,
  status VARCHAR(20) DEFAULT 'available'
)
```

---

## 4. Routing Algorithm

### 4.1 Qualified Name Format

All MCP tools use a namespaced qualified name: `mcp:<server-slug>:<tool-name>`

Examples: `mcp:github:create_issue`, `mcp:slack:chat_postMessage`

This prevents collisions when multiple servers expose identically-named tools.

### 4.2 Resolution Flow

```
resolve(toolName, agentId, agentConfig)
  │
  ├── Starts with "mcp:" ?
  │   ├── YES → resolveQualified(serverSlug, toolName)
  │   │         → Direct lookup: mcp_server_tool JOIN mcp_server
  │   │         → WHERE slug = $slug AND name = $name AND status = ACTIVE
  │   │         → Return ToolDefinition or null
  │   │
  │   └── NO  → resolveUnqualified(toolName, agentId, agentConfig)
  │             → Search mcp_server_tool WHERE name = $name AND server ACTIVE
  │             → 0 matches → null (fall through to webhook/built-in)
  │             → 1 match   → return it
  │             → N matches → conflict resolution:
  │                 1. Agent scope — prefer servers scoping this agent
  │                 2. Agent preference — mcp_preferences.server_priority
  │                 3. First registered — mcp_server.created_at ASC
  │                 4. Ambiguity error — "use qualified name"
```

### 4.3 Batch Resolution (resolveAll)

Used during agent execution setup to build the full tool registry:

```typescript
mcpToolRouter.resolveAll(agentId, allowedTools, deniedTools): ToolDefinition[]
```

Filters:
- `mcp_server.status = 'ACTIVE'` — only healthy servers
- `mcp_server_tool.status = 'available'` — only enabled tools
- `agent_scope` includes `agentId` (or scope is empty → all agents)
- `qualified_name` matches `allowedTools` patterns (exact or glob)
- `deniedTools` take precedence over `allowedTools`

**Glob support:** `mcp:github:*` matches all tools from the `github` server. `mcp:*:search` matches any server's `search` tool.

### 4.4 Caching

All resolution results are cached in-memory with a 60-second TTL:
- Key: serialized query params (agentId + allow/deny lists)
- Invalidated on demand via `invalidateCache()`
- No cross-process cache — each control-plane instance maintains its own

---

## 5. Lifecycle Management

### 5.1 Server Status Model

```sql
CREATE TYPE mcp_server_status AS ENUM (
  'PENDING',    -- registered, not yet probed
  'ACTIVE',     -- healthy, serving tools
  'DEGRADED',   -- circuit half-open, intermittent failures
  'ERROR',      -- circuit open, consecutive failures
  'DISABLED'    -- operator-disabled, excluded from routing
);
```

State machine:

```
PENDING ──(probe success)──► ACTIVE ──(failures)──► DEGRADED ──(more failures)──► ERROR
   ▲                           ▲                       │                           │
   │                           └───(recovery)──────────┘                           │
   │                           ▲                                                   │
   │                           └────────────(half-open probe success)───────────────┘
   │
   └──── POST /mcp-servers/:id/refresh (operator reset)
```

### 5.2 Health Probing

The `McpHealthSupervisor` runs a periodic tick loop:

1. **Fetch** all non-DISABLED servers from `mcp_server`
2. **Filter** servers whose probe interval has elapsed
3. **Probe** each server: HTTP GET to `connection.url` (10s timeout)
   - Success = response 2xx or 405 (GET not supported, but server alive)
   - Failure = timeout, connection refused, 5xx
4. **Record** in per-server `CircuitBreaker`
5. **Derive** new status: CLOSED → ACTIVE, HALF_OPEN → DEGRADED, OPEN → ERROR
6. **Persist** status, `last_healthy_at`, `error_message` to DB
7. **Broadcast** SSE event on status change (`mcp:health`)

Circuit breaker configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `failureThreshold` | 3 | Failures before OPEN |
| `windowMs` | 120,000 | Failure window |
| `openDurationMs` | 30,000 | Time before trying HALF_OPEN |
| `halfOpenMaxAttempts` | 1 | Probes allowed in HALF_OPEN |
| `successThresholdToClose` | 2 | Successes to return to CLOSED |

### 5.3 Deployment Models

**Phase 1 (current): External servers only.** Operators deploy MCP servers themselves (Docker, k8s, cloud) and register the URL.

**Phase 2 (planned):**
- **In-cluster k8s Deployment** (#288): Cortex Plane creates a k8s Deployment + Service for operator-selected MCP server images. Lifecycle is fully managed.
- **stdio sidecar injection** (#289): For MCP servers that only support stdio transport, inject as a sidecar container into the agent pod. Communication via stdin/stdout.

---

## 6. Transport Decision

### 6.1 Primary: Streamable HTTP

**Decision: Streamable HTTP over deprecated SSE transport.**

Rationale:
- Single HTTP endpoint (`POST` with JSON-RPC body) — simpler than SSE's dual-endpoint model
- Supports multiple concurrent clients — no per-connection server state required
- k8s-native: works with standard load balancers, Ingress, service mesh
- Forward-compatible with MCP spec (SSE transport is deprecated as of 2025-03)

Implementation (`client-pool.ts`):

```typescript
// Standard MCP JSON-RPC call
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: crypto.randomUUID(),
  }),
})
```

### 6.2 Future: stdio (sidecar)

For MCP servers that only support stdio transport, planned via sidecar injection (#289). Communication over stdin/stdout using Node.js child process or k8s shared volume pipes.

### 6.3 Tools Only in v1

**Decision: Only `tools/call` is supported.** MCP resources and prompts are deferred — they add complexity without clear v1 demand.

---

## 7. Integration with Agent Execution

### 7.1 Execution Flow

```
agent_execute.ts:
  1. Load agent definition + skill config
  2. Check approval gate
  3. Resolve skills → merge constraints (intersection for allowed, union for denied)
  4. Build ExecutionTask with allowedTools / deniedTools
  5. Route to backend (HttpLlmBackend)
  6. If backend supports createAgentRegistry():
     → Pass mcpToolRouter as dependency
     → mcpToolRouter.resolveAll(agentId, allowedTools, deniedTools)
     → Build ToolRegistry with MCP + built-in + webhook tools
  7. Execute task with agent-specific ToolRegistry
  8. Stream events (tool_use → tool_result → text → usage → complete)
```

### 7.2 Tool Registry Composition

```typescript
// tool-executor.ts — createAgentToolRegistry()
const registry = createDefaultToolRegistry()
  // Built-in: echo, web_search, memory_query, memory_store, http_request

// Add webhook tools from agent.config.tools
for (const spec of parseWebhookTools(agentConfig)) {
  registry.register(createWebhookTool(spec))
}

// Merge MCP tools when router is available
if (mcpRouter && agentId) {
  const mcpTools = await mcpRouter.resolveAll(agentId, allowedTools, deniedTools)
  for (const tool of mcpTools) {
    registry.register(tool)  // name = qualified MCP name
  }
}
```

### 7.3 Tool Execution

When the LLM emits a `tool_use` block with an MCP tool name:
1. `ToolRegistry.get(name)` looks up the `ToolDefinition`
2. `tool.execute(input)` delegates to `McpClientPool.callTool()`
3. Client pool looks up `mcp_server.connection.url` from DB
4. Issues JSON-RPC `tools/call` request
5. Extracts text content from MCP response
6. Returns string result to the LLM conversation

---

## 8. Versioning and Upgrades

### 8.1 Tool Schema Changes

When an MCP server upgrades and changes tool schemas:
- `POST /mcp-servers/:id/refresh` resets status to PENDING, triggering re-probe
- Future: `tools/list` re-sync updates `mcp_server_tool.input_schema` and `description`
- The tool router's 60s TTL cache means stale definitions expire naturally

### 8.2 Protocol Version Tracking

`mcp_server.protocol_version` stores the MCP protocol version reported during initialization. `mcp_server.server_info` stores server name and version metadata. These are informational — the client pool speaks standard JSON-RPC regardless of version.

### 8.3 Backward Compatibility

The `agent_scope` column on `mcp_server` is deprecated in favor of `agent_tool_binding` (see [Agent Capability Model](./agent-capabilities.md)). Migration #021 converts existing `agent_scope` arrays into per-tool binding rows. The column remains for backward compat during transition.

---

## 9. API Surface

### 9.1 MCP Server Management

```
POST   /mcp-servers                    Create MCP server
  Body: { name, slug?, transport, connection, agent_scope?, description?, health_probe_interval_ms? }
  Response: 201 { ...server }
  Auth: operator

GET    /mcp-servers                    List servers (paginated)
  Query: ?status=ACTIVE&limit=50&offset=0
  Response: 200 { servers, count, pagination }

GET    /mcp-servers/:id                Get server by ID (includes tools)
  Response: 200 { ...server, tools: [...] }

PUT    /mcp-servers/:id                Update server
  Body: { name?, transport?, connection?, agent_scope?, description?, status?, health_probe_interval_ms? }
  Response: 200 { ...server }
  Auth: operator

DELETE /mcp-servers/:id                Delete server (cascades tools)
  Response: 200 { ...deleted }
  Auth: operator

POST   /mcp-servers/:id/refresh        Trigger re-probe (reset to PENDING)
  Response: 200 { ...server, status: "PENDING" }
  Auth: operator
```

### 9.2 Health Monitoring

```
GET    /health/mcp                     MCP health summary
  Response: 200 {
    status: "ok" | "degraded" | "unavailable",
    servers: [{
      serverId, slug, status,
      circuitBreaker: { state, failureCount, successCount, lastFailureAt },
      lastProbeAt, lastError, consecutiveFailures
    }],
    probeIntervalMs
  }

GET    /health/stream                  SSE stream — includes mcp:health events
  Event: { serverId, slug, previousStatus, status, circuitBreaker, lastError, timestamp }
```

---

## 10. Data Model

### 10.1 Tables

```sql
-- Migration 015
CREATE TABLE mcp_server (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(255) NOT NULL,
  slug                     VARCHAR(255) UNIQUE NOT NULL,
  transport                mcp_transport NOT NULL,          -- 'streamable-http' | 'stdio'
  connection               JSONB NOT NULL,                  -- { url, headers_enc? }
  agent_scope              JSONB NOT NULL DEFAULT '[]',     -- DEPRECATED
  description              TEXT,
  status                   mcp_server_status NOT NULL DEFAULT 'PENDING',
  protocol_version         VARCHAR(20),
  server_info              JSONB,
  capabilities             JSONB,
  health_probe_interval_ms INTEGER NOT NULL DEFAULT 30000,
  last_healthy_at          TIMESTAMPTZ,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mcp_server_tool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_server_id   UUID NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  qualified_name  VARCHAR(511) NOT NULL,                   -- 'mcp:<slug>:<name>'
  description     TEXT,
  input_schema    JSONB NOT NULL,
  annotations     JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'available',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(mcp_server_id, name)
);

CREATE INDEX idx_mcp_server_tool_qualified ON mcp_server_tool(qualified_name);
CREATE INDEX idx_mcp_server_tool_name ON mcp_server_tool(name);
```

### 10.2 Enums

```sql
CREATE TYPE mcp_server_status AS ENUM ('PENDING','ACTIVE','DEGRADED','ERROR','DISABLED');
CREATE TYPE mcp_transport AS ENUM ('streamable-http','stdio');
```

---

## 11. Ecosystem Audit — Priority MCP Servers

| Server | Use Case | Status | Phase |
|--------|----------|--------|-------|
| `@modelcontextprotocol/server-github` | Issues, PRs, repos, code search | Mature, official | Phase 1 |
| `@modelcontextprotocol/server-filesystem` | File read/write in mounted volumes | Mature, official | Phase 1 |
| `@modelcontextprotocol/server-slack` | Channel messages, thread replies | Mature, official | Phase 2 |
| `@anthropic/mcp-server-google-workspace` | Calendar, Drive, Gmail | Beta | Phase 2 |
| `@modelcontextprotocol/server-brave-search` | Web search | Stable | Phase 2 |
| `@modelcontextprotocol/server-postgres` | Database queries | Stable | Phase 3 |
| Custom (webhook bridge) | Legacy REST APIs via MCP adapter | Planned | Phase 3 |

---

## 12. Key Decisions Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Streamable HTTP** over deprecated SSE | Single endpoint, multi-client, k8s-native |
| 2 | **Database-backed registry** over CRD | API-first, simpler for v1 |
| 3 | **Tools only** in v1 | Resources/prompts add complexity without clear demand |
| 4 | **Namespaced tool names** (`mcp:<slug>:<tool>`) | Prevents collisions across servers |
| 5 | **`@modelcontextprotocol/sdk`** | Official TypeScript SDK for client implementation |
| 6 | **External servers first** | Simpler; in-cluster deployment deferred to Phase 2 |
| 7 | **Per-server circuit breakers** | Isolate failures; one bad server doesn't take down all MCP |
| 8 | **60s TTL cache** | Balance freshness vs DB load; invalidate on demand |
| 9 | **Connection header encryption** | API keys at rest protected via AES-256-GCM |
| 10 | **`agent_scope` deprecated** | Replaced by explicit `agent_tool_binding` per tool |

---

## 13. Implementation Status

### Critical Path (Phase 1) — COMPLETE

| Ticket | Title | Status |
|--------|-------|--------|
| #281 | `feat(db): migration 015 — mcp_server + mcp_server_tool tables` | Closed |
| #282 | `feat(routes): MCP server CRUD API endpoints` | Closed |
| #284 | `feat(mcp): tool router — MCP tool resolution and conflict handling` | Closed |
| #285 | `feat(mcp): health supervisor + /health/mcp route` | Closed |
| #286 | `feat(mcp): agentic loop integration — MCP tools in ToolRegistry` | Closed |

### Phase 2 — IN PROGRESS

| Ticket | Title | Status | Depends On |
|--------|-------|--------|------------|
| #283 | `feat(mcp): MCP client pool — Streamable HTTP + stdio transports` | Open | — |
| #287 | `feat(dashboard): MCP server management UI` | Open | #282 |
| #288 | `feat(mcp): in-cluster MCP server deployment via k8s Deployment` | Open | #282, #283 |
| #289 | `feat(mcp): stdio sidecar injection for agent pods` | Open | #283, #288 |
| #290 | `feat(mcp): E2E validation — GitHub + Filesystem MCP servers` | Open | #286, #288 |

### Execution Order

```
Week 1: #281 → #282 (serial)  |  #283 (parallel track)     ✓ DONE
Week 2: #284 → #286           |  #285 (parallel)            ✓ DONE
Week 3: #287, #288             |  (can parallel)             ◻ PLANNED
Week 4: #289 → #290                                         ◻ PLANNED
```

---

## 14. Related Design Documents

- [Agent Capability Model](./agent-capabilities.md) — replaces `agent_scope` with per-tool `agent_tool_binding`
- [Agent Lifecycle & Resilience](./agent-lifecycle.md) — circuit breakers, checkpointing, quarantine
