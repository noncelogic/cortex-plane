# MCP Server Integration — Design Document

> **Spike:** #262 — MCP server integration: discovery, lifecycle, and routing
> **Status:** Draft
> **Authors:** @cortex-plane team
> **Date:** 2026-03-02

---

## 1. Overview

Cortex Plane gains the ability to discover, deploy, manage, and route tool
calls to [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
servers. MCP servers are the standardised escape hatch from CLI-local tools:
containerised, observable, multi-tenant, with a rapidly growing ecosystem.

### North Star

> OpenClaw capabilities (skills like gog, github, browser) but containerised,
> observable, and multi-tenant. Not fragile local scripts.

### Goals

1. Operators register MCP servers via API or CRD — Cortex Plane handles
   lifecycle, health, and routing.
2. Agents reference MCP tools by name in `allowedTools` — the control plane
   resolves which MCP server provides each tool.
3. Health model covers server-level, transport-level, and per-tool readiness.
4. Architecture is k8s-native and extends existing Backend Registry / Tool
   Registry patterns without breaking them.

### Non-Goals (this phase)

- Multi-tenant tool isolation (future: per-user credential scoping).
- MCP resource or prompt primitives (tools only in v1).
- Federated / cross-cluster MCP discovery.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Control Plane                            │
│                                                                 │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────┐    │
│  │  Agent    │──▶│  Tool Router │──▶│  MCP Client Pool     │    │
│  │  Agentic  │   │              │   │                      │    │
│  │  Loop     │   │  1. built-in │   │  ┌────────────────┐  │    │
│  │  (http-   │   │  2. webhook  │   │  │ MCP Client A   │──┼───▶ MCP Server A (in-cluster)
│  │   llm)    │   │  3. mcp:*    │   │  │ (Streamable    │  │    │   k8s Deployment + Service
│  └──────────┘   └──────────────┘   │  │  HTTP)         │  │    │
│                                     │  └────────────────┘  │    │
│  ┌──────────┐   ┌──────────────┐   │  ┌────────────────┐  │    │
│  │ MCP      │   │ MCP Server   │   │  │ MCP Client B   │──┼───▶ MCP Server B (external)
│  │ Server   │──▶│ Registry     │──▶│  │ (Streamable    │  │    │   https://mcp.example.com
│  │ CRUD API │   │ (DB + Cache) │   │  │  HTTP)         │  │    │
│  └──────────┘   └──────────────┘   │  └────────────────┘  │    │
│                                     │  ┌────────────────┐  │    │
│  ┌──────────┐   ┌──────────────┐   │  │ MCP Client C   │──┼───▶ MCP Server C (sidecar)
│  │ Health   │──▶│ MCP Health   │   │  │ (stdio)        │  │    │   agent pod sidecar
│  │ Routes   │   │ Supervisor   │   │  └────────────────┘  │    │
│  └──────────┘   └──────────────┘   └──────────────────────┘    │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐           │
│  │  PostgreSQL: mcp_server + mcp_server_tool tables │           │
│  └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

### Component Roles

| Component | Responsibility |
|-----------|---------------|
| **MCP Server CRUD API** | REST endpoints to register, update, delete, list MCP servers |
| **MCP Server Registry** | DB-backed catalog of known MCP servers with cached tool manifests |
| **MCP Client Pool** | Manages persistent MCP client connections (one per server) |
| **Tool Router** | Resolves `tool_use` calls: built-in → webhook → MCP, with conflict resolution |
| **MCP Health Supervisor** | Periodic health probes per MCP server; circuit breaker integration |
| **Health Routes** | Exposes `/health/mcp` for observability |

---

## 3. Registration and Discovery

### 3.1 Registration Model

An operator registers MCP servers through the REST API. Each server record
captures transport, endpoint, and metadata:

```typescript
// POST /mcp-servers
interface CreateMcpServerBody {
  /** Human-readable name. */
  name: string
  /** Unique slug (auto-generated from name if omitted). */
  slug?: string
  /** Transport type. */
  transport: "streamable-http" | "stdio"
  /** Connection details — shape depends on transport. */
  connection: StreamableHttpConnection | StdioConnection
  /** Which agents may use this server (empty = all). */
  agent_scope: string[]
  /** Operator-provided description. */
  description?: string
  /** Optional: override health probe interval (ms). */
  health_probe_interval_ms?: number
}

interface StreamableHttpConnection {
  /** MCP endpoint URL (e.g. https://mcp-github.cortex-plane.svc/mcp). */
  url: string
  /** Optional headers (e.g. Authorization). Encrypted at rest. */
  headers?: Record<string, string>
  /** Request timeout (ms). Default 30000. */
  timeout_ms?: number
}

interface StdioConnection {
  /** Container image to run. */
  image: string
  /** Command and args to start the MCP server. */
  command: string[]
  /** Environment variables (secrets referenced via k8s Secrets). */
  env?: Record<string, string>
}
```

### 3.2 Discovery Flow

```
Operator                Control Plane              MCP Server
  │                          │                         │
  │  POST /mcp-servers       │                         │
  │─────────────────────────▶│                         │
  │                          │  INSERT mcp_server row  │
  │                          │─────────┐               │
  │                          │◀────────┘               │
  │                          │                         │
  │                          │  MCP initialize()       │
  │                          │────────────────────────▶│
  │                          │  capabilities + tools   │
  │                          │◀────────────────────────│
  │                          │                         │
  │                          │  tools/list             │
  │                          │────────────────────────▶│
  │                          │  tool definitions       │
  │                          │◀────────────────────────│
  │                          │                         │
  │                          │  UPSERT mcp_server_tool │
  │                          │─────────┐               │
  │                          │◀────────┘               │
  │                          │                         │
  │  201 { id, tools[] }     │                         │
  │◀─────────────────────────│                         │
```

After registration, the control plane:

1. Inserts the server record into `mcp_server`.
2. Opens an MCP client connection (Streamable HTTP or stdio).
3. Performs the MCP `initialize` handshake.
4. Calls `tools/list` to discover tool definitions.
5. Stores tool metadata in `mcp_server_tool` (name, description, inputSchema).
6. Marks the server status `ACTIVE`.

If initialization fails, the server is marked `ERROR` with a diagnostic
message — the operator can retry or fix the configuration.

### 3.3 Tool Refresh

MCP servers that declare the `tools.listChanged` capability will send
`notifications/tools/list_changed`. On receipt, the control plane re-fetches
the tool list and reconciles the `mcp_server_tool` table.

A manual refresh is also available: `POST /mcp-servers/:id/refresh`.

### 3.4 API Endpoints

```
POST   /mcp-servers                  — Register a new MCP server
GET    /mcp-servers                  — List registered servers (?status=ACTIVE)
GET    /mcp-servers/:id              — Get server detail + tools
PUT    /mcp-servers/:id              — Update server config
DELETE /mcp-servers/:id              — Deregister server (graceful shutdown)
POST   /mcp-servers/:id/refresh      — Re-fetch tool manifest
GET    /mcp-servers/:id/health       — Get server health detail
GET    /health/mcp                   — Aggregate MCP health summary
```

---

## 4. Data Model

### 4.1 mcp_server Table

```sql
CREATE TYPE mcp_server_status AS ENUM (
  'PENDING',     -- registered, not yet initialized
  'ACTIVE',      -- healthy, accepting tool calls
  'DEGRADED',    -- partially healthy (some tools failing)
  'ERROR',       -- initialization failed or consecutive health failures
  'DISABLED'     -- operator-disabled
);

CREATE TYPE mcp_transport AS ENUM ('streamable-http', 'stdio');

CREATE TABLE mcp_server (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(255) UNIQUE NOT NULL,
  transport       mcp_transport NOT NULL,
  connection      JSONB NOT NULL,           -- encrypted headers stored here
  agent_scope     JSONB NOT NULL DEFAULT '[]',
  description     TEXT,
  status          mcp_server_status NOT NULL DEFAULT 'PENDING',
  protocol_version VARCHAR(20),             -- negotiated MCP version
  server_info     JSONB,                    -- serverInfo from initialize
  capabilities    JSONB,                    -- server capabilities
  health_probe_interval_ms INTEGER NOT NULL DEFAULT 30000,
  last_healthy_at TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.2 mcp_server_tool Table

```sql
CREATE TABLE mcp_server_tool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_server_id   UUID NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  qualified_name  VARCHAR(511) NOT NULL,    -- "mcp:<server-slug>:<tool-name>"
  description     TEXT,
  input_schema    JSONB NOT NULL,
  annotations     JSONB,                    -- readOnlyHint, destructiveHint, etc.
  status          VARCHAR(20) NOT NULL DEFAULT 'available',  -- available | unavailable | error
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mcp_server_id, name)
);

CREATE INDEX idx_mcp_server_tool_qualified ON mcp_server_tool(qualified_name);
CREATE INDEX idx_mcp_server_tool_name ON mcp_server_tool(name);
```

### 4.3 Kysely Type Additions

```typescript
// packages/control-plane/src/db/types.ts additions

export type McpServerStatus = "PENDING" | "ACTIVE" | "DEGRADED" | "ERROR" | "DISABLED"
export type McpTransport = "streamable-http" | "stdio"

export interface McpServerTable {
  id: Generated<string>
  name: string
  slug: string
  transport: McpTransport
  connection: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  agent_scope: ColumnType<string[], string[] | undefined, string[]>
  description: string | null
  status: ColumnType<McpServerStatus, McpServerStatus | undefined, McpServerStatus>
  protocol_version: string | null
  server_info: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>
  capabilities: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>
  health_probe_interval_ms: ColumnType<number, number | undefined, number>
  last_healthy_at: Date | null
  error_message: string | null
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}

export interface McpServerToolTable {
  id: Generated<string>
  mcp_server_id: string
  name: string
  qualified_name: string
  description: string | null
  input_schema: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>
  annotations: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>
  status: ColumnType<string, string | undefined, string>
  created_at: ColumnType<Date, Date | undefined, never>
  updated_at: ColumnType<Date, Date | undefined, Date>
}
```

---

## 5. Lifecycle Management

### 5.1 Server Lifecycle States

```
                  register
  ┌─────────┐  ───────────▶  ┌─────────┐
  │ (none)  │                │ PENDING │
  └─────────┘                └────┬────┘
                                  │ initialize() OK
                                  ▼
                             ┌─────────┐
                      ┌──────│ ACTIVE  │◀──────┐
                      │      └────┬────┘       │
                      │           │            │ recovery
                      │           │ health     │
                      │           │ degraded   │
                      │           ▼            │
                      │      ┌──────────┐      │
                      │      │ DEGRADED │──────┘
                      │      └────┬─────┘
                      │           │ consecutive failures
                      │           ▼
                      │      ┌─────────┐
                      ├──────│  ERROR  │
                      │      └─────────┘
                      │
                      │ operator disable
                      ▼
                 ┌──────────┐
                 │ DISABLED │
                 └──────────┘
```

### 5.2 In-Cluster MCP Servers (stdio)

For stdio-transport servers, Cortex Plane deploys a **sidecar container**
alongside the agent pod or a **standalone Deployment** in the `cortex-plane`
namespace:

**Sidecar Pattern** (tight coupling, one server per agent pod):
- Control plane adds the MCP server container to the agent pod spec.
- Communication via stdio (stdin/stdout over shared process namespace).
- Lifecycle tied to agent pod — born and dies with the agent.
- Best for: agent-specific tools, sandboxed execution.

**Deployment Pattern** (shared, multiple agents):
- Control plane creates a k8s Deployment + Service for the MCP server.
- Agents connect via Streamable HTTP through the Service ClusterIP.
- Independent lifecycle, horizontally scalable.
- Best for: shared infrastructure tools (GitHub, Slack, databases).

### 5.3 External MCP Servers

External servers require only a URL and optional auth headers:

```json
{
  "transport": "streamable-http",
  "connection": {
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer <token>" },
    "timeout_ms": 30000
  }
}
```

The control plane validates connectivity during registration and maintains
a persistent client connection.

### 5.4 Graceful Lifecycle Operations

| Operation | Behaviour |
|-----------|-----------|
| **Register** | Insert DB row → initialize MCP client → fetch tools → mark ACTIVE |
| **Disable** | Drain in-flight tool calls → close MCP client → mark DISABLED |
| **Delete** | Disable first → delete DB rows → remove k8s resources (if in-cluster) |
| **Upgrade** | Register new version → health check passes → migrate agent_scope → disable old |
| **Restart** | Close client → reconnect → re-initialize → reconcile tools |

### 5.5 Control Plane Startup

On startup, the control plane loads all `ACTIVE` + `DEGRADED` servers from the
database and initializes MCP client connections. Servers that fail to connect
are marked `ERROR` and retried on the next health probe cycle.

---

## 6. Routing Algorithm

### 6.1 Tool Naming Convention

MCP tools use a namespaced naming scheme to avoid collisions:

```
mcp:<server-slug>:<tool-name>
```

Examples:
- `mcp:github:create_issue`
- `mcp:slack:send_message`
- `mcp:filesystem:read_file`

Agents reference tools using either:
- **Qualified names** (explicit): `"mcp:github:create_issue"` — routes directly.
- **Unqualified names** (convenient): `"create_issue"` — resolved by the router.
- **Glob patterns**: `"mcp:github:*"` — all tools from a server.

### 6.2 Resolution Algorithm

When the agentic loop receives a `tool_use` event with `toolName`:

```
resolve(toolName, agent) → ToolDefinition | error

1. EXACT MATCH — built-in registry
   If toolRegistry.get(toolName) exists → return it.
   (Covers echo, web_search, memory_query, etc.)

2. QUALIFIED MCP MATCH — "mcp:<slug>:<name>"
   Parse toolName. Look up mcp_server by slug.
   If server is ACTIVE and tool status is 'available' → route to MCP client.

3. UNQUALIFIED MCP SEARCH
   Query mcp_server_tool WHERE name = toolName
     AND mcp_server.status = 'ACTIVE'
     AND tool.status = 'available'
     AND (mcp_server.agent_scope = '[]' OR agent.id IN agent_scope).

   a. 0 results → return "Unknown tool" error.
   b. 1 result  → route to that MCP server.
   c. N results → CONFLICT RESOLUTION (see §6.3).

4. WEBHOOK FALLBACK
   If agent.config.tools has a webhook tool with matching name → route there.
```

### 6.3 Conflict Resolution

When multiple MCP servers expose the same unqualified tool name:

1. **Agent scope wins.** If only one server includes this agent in its
   `agent_scope`, use it.
2. **Explicit agent config wins.** If the agent's `config.mcp_preferences`
   declares a server priority for this tool, use it.
3. **First registered wins.** Deterministic fallback based on
   `mcp_server.created_at ASC`.
4. **Error if ambiguous.** If none of the above resolves it, return an error
   asking the operator to use a qualified name.

In practice, operators are encouraged to use qualified names (`mcp:github:*`)
in agent `allowedTools` to avoid ambiguity.

### 6.4 Tool Resolution Cache

Tool resolution is cached in-memory with a 60-second TTL to avoid per-call
DB queries. The cache is invalidated when:

- An MCP server's tool list is refreshed.
- A server status changes.
- An agent's `allowedTools` or `config` changes.

---

## 7. Transport Decision

### Decision: Streamable HTTP (primary), stdio (sidecar only)

| Factor | Streamable HTTP | stdio |
|--------|----------------|-------|
| Multi-client | Yes | No (1:1) |
| Networked | Yes | No (local only) |
| Scalable | Yes (HPA) | No |
| k8s Service mesh | Native | N/A |
| Session management | Built-in (Mcp-Session-Id) | Implicit |
| Resumability | SSE event IDs + Last-Event-ID | N/A |
| Complexity | Moderate | Simple |
| Spec status | Current standard | Current standard |

**Rationale:**

Streamable HTTP is the primary transport because Cortex Plane is k8s-native
and most MCP servers will be shared across agents (networked access required).
It aligns with existing patterns — Fastify HTTP routes, SSE streaming, Service
ClusterIP networking.

stdio is supported only for sidecar-deployed servers where a dedicated
MCP server runs in the agent pod. This covers niche use cases (sandboxed
filesystem access, agent-specific tools) without network overhead.

The deprecated SSE transport (2024-11-05) is **not** supported. The Streamable
HTTP transport subsumes its functionality with a single endpoint.

### Transport-Specific Implementation Notes

**Streamable HTTP:**
- MCP client sends `POST` to the server's `/mcp` endpoint.
- Server responds with `application/json` (single result) or
  `text/event-stream` (streaming responses).
- Session managed via `Mcp-Session-Id` header.
- Client sends `MCP-Protocol-Version: 2025-11-25` on all requests.
- Reconnection via `Last-Event-ID` for resumability.

**stdio:**
- Control plane spawns container process and communicates via stdin/stdout.
- JSON-RPC messages delimited by newlines.
- Process lifecycle managed by k8s pod lifecycle.

---

## 8. Health Model

### 8.1 Three-Tier MCP Health

| Level | Probe | Frequency | Failure Threshold |
|-------|-------|-----------|-------------------|
| **Server liveness** | MCP `ping` method | Every `health_probe_interval_ms` (default 30s) | 3 consecutive failures → DEGRADED |
| **Server readiness** | `tools/list` succeeds + at least 1 tool available | On registration, after reconnect | Immediate → ERROR |
| **Tool-level** | Track per-tool error rate from execution results | Continuous (per invocation) | 5 consecutive errors → tool status `error` |

### 8.2 Health Supervisor

```typescript
class McpHealthSupervisor {
  // Runs periodic probe cycles for all registered servers
  async startProbing(): Promise<void>
  async stopProbing(): Promise<void>

  // Per-server health check
  async probeServer(serverId: string): Promise<McpServerHealthReport>

  // Circuit breaker integration
  recordToolOutcome(serverId: string, toolName: string, success: boolean): void

  // Observable
  on(event: 'health_change', handler: (report: McpServerHealthReport) => void): void
}

interface McpServerHealthReport {
  serverId: string
  serverSlug: string
  status: McpServerStatus
  transport: McpTransport
  pingLatencyMs: number | null
  toolCount: number
  healthyToolCount: number
  lastProbeAt: string
  circuitState: CircuitState
  error?: string
}
```

### 8.3 Circuit Breaker

Each MCP server gets its own circuit breaker, consistent with the existing
`BackendRegistry` pattern:

- **Closed** (normal): Requests flow through.
- **Open** (tripped): 5 consecutive failures → all tool calls short-circuit
  with an error for 60s.
- **Half-open**: After 60s, one probe request is allowed through. If it
  succeeds → Closed. If it fails → Open again.

### 8.4 Health API

```
GET /health/mcp → {
  status: "ok" | "degraded" | "unhealthy",
  servers: McpServerHealthReport[]
}

GET /mcp-servers/:id/health → McpServerHealthReport
```

Health changes are broadcast via SSE on the `_mcp_health` event type,
following the existing `_channel_health` pattern.

---

## 9. MCP Client Pool

### 9.1 Design

The `McpClientPool` manages one MCP client connection per registered server.
Connections are persistent and reused across tool calls.

```typescript
class McpClientPool {
  // Connection management
  async connect(server: McpServer): Promise<McpClientConnection>
  async disconnect(serverId: string): Promise<void>
  async disconnectAll(): Promise<void>

  // Tool execution — the core integration point
  async callTool(
    serverId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }>

  // Status
  getConnection(serverId: string): McpClientConnection | undefined
  isConnected(serverId: string): boolean
}

interface McpClientConnection {
  serverId: string
  transport: McpTransport
  protocolVersion: string
  capabilities: McpServerCapabilities
  sessionId: string | null      // Streamable HTTP session ID
  connectedAt: Date
}
```

### 9.2 Tool Execution Bridge

The pool bridges MCP tool calls to the existing `ToolDefinition` interface:

```typescript
function createMcpToolDefinition(
  pool: McpClientPool,
  server: McpServer,
  tool: McpServerTool,
): ToolDefinition {
  return {
    name: tool.qualified_name,
    description: tool.description ?? "",
    inputSchema: tool.input_schema,
    execute: async (input) => {
      const result = await pool.callTool(server.id, tool.name, input)
      if (result.isError) throw new Error(result.output)
      return result.output
    },
  }
}
```

This means MCP tools are registered into the existing `ToolRegistry` and
participate in the standard `resolve()` / `execute()` flow.

### 9.3 SDK Choice

Use the official `@modelcontextprotocol/sdk` TypeScript package for
client implementation. It handles:
- JSON-RPC 2.0 framing
- Streamable HTTP and stdio transports
- Initialize/shutdown handshake
- Capability negotiation
- Progress tracking and cancellation

---

## 10. Versioning, Upgrades, and Compatibility

### 10.1 Protocol Version Strategy

- Cortex Plane supports MCP protocol version `2025-11-25` (current).
- The negotiated version is stored per-server in `mcp_server.protocol_version`.
- If a server responds with an unsupported version, registration fails with
  a clear error message.
- Future protocol versions are added by updating the MCP SDK dependency and
  adding the version to the supported list.

### 10.2 Server Upgrades

**Rolling upgrade procedure:**

1. Register the new server version alongside the old one (different slug,
   e.g., `github-v2`).
2. Validate: health checks pass, tool list is correct.
3. Migrate agents: update `allowedTools` references.
4. Disable and delete the old server.

**Tool schema changes:**

- When `tools/list` returns updated schemas, the `mcp_server_tool` table is
  reconciled:
  - New tools → inserted.
  - Changed tools → updated (input_schema, description, annotations).
  - Removed tools → soft-deleted (status → `unavailable`).
- Agents referencing removed tools get an error on next invocation with a
  clear message.

### 10.3 Backward Compatibility

- The existing `ToolRegistry`, `ToolDefinition`, and `resolve()`/`execute()`
  interfaces are preserved. MCP tools are adapters that satisfy the same
  interface.
- The existing `allowedTools` / `deniedTools` constraint system works
  unchanged — MCP tools are referenced by their qualified name.
- No breaking changes to the agent API. Agents opt in to MCP by listing
  `mcp:*` tool names.

---

## 11. Security

### 11.1 Transport Security

- All Streamable HTTP connections to external servers **must** use HTTPS.
- In-cluster connections use k8s Service DNS (HTTP within the cluster network
  is acceptable — mTLS via service mesh is recommended for production).
- stdio connections are pod-local (no network exposure).

### 11.2 Credential Handling

- MCP server connection headers (e.g., `Authorization: Bearer`) are encrypted
  at rest using the same `CREDENTIAL_MASTER_KEY` as `provider_credential`.
- Headers are decrypted only in-memory when establishing the MCP client
  connection.
- stdio env vars reference k8s Secrets — the control plane renders Secret
  references into the pod spec.

### 11.3 Tool Sandboxing

- Tools are gated by the existing `TaskConstraints.allowedTools` /
  `deniedTools` system.
- `agent_scope` on the MCP server limits which agents can access it.
- Tool annotations (`destructiveHint`, `readOnlyHint`) are stored and can
  be used to gate approval-required tool calls.

### 11.4 Origin Validation

The control plane MCP client sets the `Origin` header to
`https://cortex-plane.local` on all Streamable HTTP requests. MCP servers
should allowlist this origin.

---

## 12. Prioritised MCP Ecosystem Shortlist

Servers prioritised by overlap with existing OpenClaw skills and agent
use cases:

| Priority | MCP Server | Use Case | Transport | Notes |
|----------|-----------|----------|-----------|-------|
| **P1** | **GitHub** | Issues, PRs, code search, releases | Streamable HTTP | Replaces/enhances agent-cdp GitHub skills |
| **P1** | **Filesystem** | Sandboxed file read/write/search | stdio (sidecar) | Agent workspace operations |
| **P1** | **Brave Search** | Web search | Streamable HTTP | Replaces built-in `web_search` tool |
| **P2** | **Slack** | Channel messaging, search | Streamable HTTP | Channel adapter enhancement |
| **P2** | **PostgreSQL** | Database queries, schema introspection | Streamable HTTP | Agent data access |
| **P2** | **Fetch** | Web content retrieval | Streamable HTTP | Replaces built-in `http_request` |
| **P2** | **Memory** | Knowledge graph persistence | Streamable HTTP | Augments Qdrant memory |
| **P3** | **Puppeteer** | Browser automation | stdio (sidecar) | Replaces agent-cdp in some cases |
| **P3** | **Kubernetes** | Cluster management | Streamable HTTP | Self-management capabilities |
| **P3** | **Google Drive** | Document access | Streamable HTTP | Credential integration required |

### Initial Deployment Target

Phase 1 implementation validates with **GitHub** (Streamable HTTP, external)
and **Filesystem** (stdio, sidecar) — covering both transport types and
both deployment patterns.

---

## 13. Configuration

### 13.1 Environment Variables

```
# MCP Client Pool
MCP_CLIENT_POOL_SIZE=10          # Max concurrent MCP connections
MCP_DEFAULT_TIMEOUT_MS=30000     # Default tool call timeout
MCP_HEALTH_PROBE_INTERVAL_MS=30000  # Default probe interval

# MCP Security
MCP_ALLOWED_ORIGINS=https://cortex-plane.local  # Origin header value

# MCP SDK (optional overrides)
MCP_PROTOCOL_VERSION=2025-11-25  # Supported protocol version
```

### 13.2 Agent Configuration Extension

```typescript
// Existing agent.config extended:
interface AgentConfig {
  // ... existing fields ...
  tools?: WebhookToolSpec[]         // existing webhook tools
  mcp_preferences?: {
    /** Server priority for unqualified tool name resolution. */
    server_priority?: string[]      // ordered list of server slugs
  }
}
```

---

## 14. Implementation Ticket Summary

The following tickets are sequenced for WIP=1 pipeline execution. Each
ticket's full spec (scope, API contracts, acceptance criteria, dependencies,
size, priority) is in the corresponding GitHub issue.

| # | Ticket | Depends On | Size | Priority |
|---|--------|------------|------|----------|
| 1 | DB migration: `mcp_server` + `mcp_server_tool` tables | — | S | p1 |
| 2 | MCP Server CRUD API routes | #1 | M | p1 |
| 3 | MCP Client Pool (Streamable HTTP + stdio) | — | L | p1 |
| 4 | Tool Router: MCP tool resolution + conflict handling | #1, #3 | M | p1 |
| 5 | MCP Health Supervisor + `/health/mcp` route | #2, #3 | M | p1 |
| 6 | Agentic loop integration: MCP tools in ToolRegistry | #3, #4 | M | p1 |
| 7 | Dashboard: MCP server management UI | #2 | M | p2 |
| 8 | In-cluster MCP server deployment (k8s Deployment) | #2, #3 | L | p2 |
| 9 | stdio sidecar injection for agent pods | #3, #8 | M | p2 |
| 10 | E2E validation: GitHub + Filesystem MCP servers | #6, #8 | M | p2 |

**Critical path:** #1 → #2 → #4 → #6 (tool calls work end-to-end)
**Parallel track:** #3 (can start immediately, no DB dependency)

---

## 15. Open Questions

1. **Multi-tenant credentials:** Should MCP server connections carry
   per-user credentials (e.g., each user's GitHub token)? Deferred to a
   follow-up spike after the credential vault (#263) is complete.
2. **MCP resources and prompts:** v1 supports tools only. Resources and
   prompts are useful but add complexity — evaluate after initial adoption.
3. **CRD-based registration:** A `McpServer` CRD would enable GitOps
   workflows. Worth adding after the API-first approach is validated.
4. **Tool approval integration:** Should MCP tools with `destructiveHint`
   automatically require approval? Natural fit with the existing approval
   gate (#036) but needs design.
