# Dashboard Design Document

> **Ticket:** #18 — Next.js Dashboard
> **Milestone:** M3: Interface Layer
> **Status:** Spike / Design
> **Depends on:** #17 (REST API), #20 (Browser Observation)

---

## 1. Overview

The Cortex Plane dashboard is a web management UI for monitoring and controlling
autonomous agents running on a k3s cluster. It provides real-time visibility into
agent execution, human approval gates, memory inspection, browser observation, and
content pipeline management.

**Key design goals:**

- **Real-time first** — SSE-driven live updates, no polling
- **Mobile-responsive** — usable from a phone for quick approvals
- **Minimal dependencies** — Tailwind CSS + native browser APIs, no heavy UI frameworks
- **Server Components by default** — client components only where interactivity requires it

---

## 2. Tech Stack

| Layer      | Choice                                    | Rationale                                       |
| ---------- | ----------------------------------------- | ----------------------------------------------- |
| Framework  | Next.js 15 (App Router)                   | React 19 Server Components, streaming SSR       |
| Styling    | Tailwind CSS 4                            | Utility-first, zero runtime, dark mode built-in |
| State      | React 19 `use()` + `useSyncExternalStore` | No external state library needed                |
| Real-time  | Native `EventSource` + custom hook        | SSE with `Last-Event-ID` reconnection           |
| Charts     | Lightweight (future — consider recharts)  | Deferred to implementation phase                |
| VNC        | noVNC embed via `<iframe>` / WebSocket    | Reuses Playwright sidecar websockify            |
| Deployment | k3s pod (Dockerfile)                      | Same cluster as control plane                   |

---

## 3. Information Architecture

```
/                          → Dashboard home (agent overview grid)
/agents/[agentId]          → Agent detail + live output stream
/agents/[agentId]/browser  → Browser observation panel (noVNC + tabs)
/agents/[agentId]/memory   → Memory explorer for this agent
/approvals                 → Approval queue (all agents)
/jobs                      → Job history + retry management
/memory                    → Global memory explorer (cross-agent search)
/pulse                     → Content pipeline dashboard ("AI Pulse")
```

---

## 4. Wireframes

### 4.1 Dashboard Home (`/`)

```
┌──────────────────────────────────────────────────────────────────┐
│  CORTEX PLANE                              [🔔 2]  [user menu]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Agent Grid ──────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │  │
│  │  │ devops-01    │  │ content-01   │  │ research-01  │    │  │
│  │  │ ● EXECUTING  │  │ ● READY      │  │ ○ DISABLED   │    │  │
│  │  │              │  │              │  │              │    │  │
│  │  │ Running:     │  │ Idle         │  │ Archived     │    │  │
│  │  │ "Deploy v2.."│  │ Last: 3m ago │  │              │    │  │
│  │  │              │  │              │  │              │    │  │
│  │  │ CPU: ▓▓▓░░   │  │ CPU: ░░░░░   │  │              │    │  │
│  │  │ MEM: ▓▓░░░   │  │ MEM: ▓░░░░   │  │              │    │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘    │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Pending Approvals (2) ───────────────────────────────────┐  │
│  │                                                            │  │
│  │  ⚠ devops-01 wants to: git push --force main             │  │
│  │    Requested 2m ago · Expires in 58m                       │  │
│  │    [Approve]  [Reject]  [View Details]                     │  │
│  │                                                            │  │
│  │  ⚠ content-01 wants to: Publish draft "AI in 2026"        │  │
│  │    Requested 15m ago · Expires in 45m                      │  │
│  │    [Approve]  [Reject]  [View Details]                     │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Recent Activity ─────────────────────────────────────────┐  │
│  │  14:35  devops-01  Job completed: "Run database migration" │  │
│  │  14:30  content-01 Approval requested: "Publish draft..."  │  │
│  │  14:25  devops-01  Checkpoint saved (CRC: 3456789012)      │  │
│  │  14:20  devops-01  Job started: "Deploy v2.1.0 to staging" │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Agent Detail (`/agents/[agentId]`)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back    devops-01                  [Steer] [Pause] [Resume]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Status: ● EXECUTING    Job: Deploy v2.1.0    Uptime: 4h 23m   │
│  Model: claude-sonnet-4-5    CPU: 450m/1000m    MEM: 312Mi/1Gi  │
│                                                                  │
│  ┌─ Live Output ─────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  [agent:output] Running migration 003_add_indexes...       │  │
│  │  [agent:output] Migration complete (1.2s)                  │  │
│  │  [agent:output] Starting deployment rollout...             │  │
│  │  [agent:output] Pod cortex-app-7d8f9 ready (3/3)          │  │
│  │  [steer:ack]   "Focus on DB first" acknowledged           │  │
│  │  [agent:output] Running health checks...                   │  │
│  │  █                                              ▼ auto-scroll│
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Steering Input ──────────────────────────────────────────┐  │
│  │  [                                          ] [Send] ○High │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Tabs ──────────────────────────────────────┐                │
│  │  [Output] [Browser] [Memory] [Job History]  │                │
│  └─────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 Browser Observation (`/agents/[agentId]/browser`)

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Back    devops-01 / Browser           [Screenshot] [Trace]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Tabs: [GitHub PR #42 ●] [Staging Dashboard] [+]                │
│                                                                  │
│  ┌─ noVNC Viewport ──────────────────────────────────────────┐  │
│  │                                                            │  │
│  │                                                            │  │
│  │           ┌──────────────────────────────┐                 │  │
│  │           │   Browser content rendered   │                 │  │
│  │           │   via VNC stream             │                 │  │
│  │           │                              │                 │  │
│  │           │   Click to annotate →        │                 │  │
│  │           │   agent receives steering    │                 │  │
│  │           └──────────────────────────────┘                 │  │
│  │                                                            │  │
│  │  Quality: [Auto ▼]    Status: ● Connected    FPS: 24      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Trace Recording ────────────────────────────────────────┐   │
│  │  Status: ● Recording (2m 15s)   [Stop & Download]        │   │
│  │  Options: ☑ Snapshots  ☑ Screenshots  ☑ Network  ☐ Console│   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 4.4 Approval Queue (`/approvals`)

```
┌──────────────────────────────────────────────────────────────────┐
│  Approvals                   Filter: [All ▼] [Pending ▼]        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Pending (2) ─────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │ ⚠ git_push_force                      devops-01   │   │  │
│  │  │ Force-push branch main to remote origin.           │   │  │
│  │  │                                                    │   │  │
│  │  │ Requested: 2m ago    Expires: 58m                  │   │  │
│  │  │ Job: 660e8400-...    Agent: devops-01              │   │  │
│  │  │                                                    │   │  │
│  │  │ [Approve ✓]  [Reject ✕]  [View Diff]              │   │  │
│  │  │ Reason: [                                 ]        │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Recent Decisions ────────────────────────────────────────┐  │
│  │  ✓ Approved  "Deploy to staging"     joe@  14:35  API     │  │
│  │  ✕ Rejected  "Delete backup table"   joe@  14:20  Telegram│  │
│  │  ⏰ Expired   "Rotate API keys"              14:00         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.5 Memory Explorer (`/memory`)

```
┌──────────────────────────────────────────────────────────────────┐
│  Memory Explorer                Agent: [All ▼]  Type: [All ▼]   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Search: [semantic search query...                    ] [Search] │
│                                                                  │
│  ┌─ Results (12 memories) ───────────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │ fact · importance: 4 · score: 0.87                 │   │  │
│  │  │ "The production database runs PostgreSQL 17 on     │   │  │
│  │  │  k3s with 10Gi PVC storage."                       │   │  │
│  │  │                                                    │   │  │
│  │  │ Tags: [database] [infrastructure]                  │   │  │
│  │  │ Source: MEMORY.md · Agent: devops-01               │   │  │
│  │  │ Created: 2d ago · Accessed: 3 times                │   │  │
│  │  │ [Edit] [Delete] [View in context]                  │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ MEMORY.md Editor ────────────────────────────────────────┐  │
│  │  ## Infrastructure                                         │  │
│  │  - PostgreSQL 17 on k3s with 10Gi PVC                     │  │
│  │  - Qdrant v1.13.2 single-node                             │  │
│  │                                                            │  │
│  │  ## Preferences                                            │  │
│  │  - Always use rolling deployments                          │  │
│  │                               [Save & Sync] [Sync Status] │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.6 Content Pipeline — "AI Pulse" (`/pulse`)

```
┌──────────────────────────────────────────────────────────────────┐
│  AI Pulse                    Filter: [Ready ▼]  [All agents ▼]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Ready to Post (3) ──────────────────────────────────────┐  │
│  │                                                            │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │ "AI Trends in 2026: What to Watch"                 │   │  │
│  │  │ content-01 · Blog post · 1,200 words               │   │  │
│  │  │                                                    │   │  │
│  │  │ Summary: Covers emerging AI capabilities in        │   │  │
│  │  │ autonomous coding, multimodal reasoning...         │   │  │
│  │  │                                                    │   │  │
│  │  │ Screenshots: [thumb1] [thumb2]                     │   │  │
│  │  │ [Preview] [Approve & Publish] [Edit] [Reject]      │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Pipeline Stats ─────────────────────────────────────────┐  │
│  │  Drafts: 5    In Review: 3    Published: 12    Rejected: 2│  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Component Architecture

```
src/
├── app/
│   ├── layout.tsx                    ← Root layout (nav shell, providers)
│   ├── page.tsx                      ← Dashboard home (agent grid + approvals)
│   ├── agents/
│   │   └── [agentId]/
│   │       ├── page.tsx              ← Agent detail + live output
│   │       ├── browser/
│   │       │   └── page.tsx          ← Browser observation (noVNC)
│   │       └── memory/
│   │           └── page.tsx          ← Per-agent memory explorer
│   ├── approvals/
│   │   └── page.tsx                  ← Global approval queue
│   ├── jobs/
│   │   └── page.tsx                  ← Job history + retry
│   ├── memory/
│   │   └── page.tsx                  ← Global memory explorer
│   └── pulse/
│       └── page.tsx                  ← Content pipeline dashboard
│
├── components/
│   ├── layout/
│   │   ├── nav-shell.tsx             ← Sidebar nav + top bar + mobile drawer
│   │   ├── page-header.tsx           ← Page title + breadcrumbs
│   │   └── notification-bell.tsx     ← Approval count badge (SSE-driven)
│   │
│   ├── agents/
│   │   ├── agent-card.tsx            ← Grid card (status, task, resources)
│   │   ├── agent-grid.tsx            ← Responsive grid of agent cards
│   │   ├── agent-status-badge.tsx    ← Lifecycle state pill (color-coded)
│   │   ├── live-output.tsx           ← SSE-driven scrolling terminal output
│   │   ├── steer-input.tsx           ← Steering message form
│   │   └── agent-controls.tsx        ← Pause/resume/steer action buttons
│   │
│   ├── approvals/
│   │   ├── approval-card.tsx         ← Single approval with actions
│   │   ├── approval-list.tsx         ← Filterable approval list
│   │   └── approval-actions.tsx      ← Approve/reject buttons + reason input
│   │
│   ├── browser/
│   │   ├── vnc-viewer.tsx            ← noVNC iframe/WebSocket embed
│   │   ├── tab-bar.tsx               ← Browser tab list from CDP
│   │   ├── screenshot-button.tsx     ← Trigger screenshot capture
│   │   └── trace-controls.tsx        ← Start/stop trace recording
│   │
│   ├── memory/
│   │   ├── memory-search.tsx         ← Semantic search input + results
│   │   ├── memory-card.tsx           ← Single memory record display
│   │   ├── memory-editor.tsx         ← Markdown editor for MEMORY.md
│   │   └── sync-status.tsx           ← Sync state indicator
│   │
│   ├── jobs/
│   │   ├── job-table.tsx             ← Paginated job history table
│   │   ├── job-status-badge.tsx      ← Job state pill
│   │   └── job-retry-button.tsx      ← Retry failed/dead-lettered jobs
│   │
│   └── pulse/
│       ├── draft-card.tsx            ← Content draft with preview
│       ├── draft-list.tsx            ← Filterable draft pipeline
│       └── pipeline-stats.tsx        ← Draft/review/published counts
│
├── hooks/
│   ├── use-sse.ts                    ← Generic SSE hook with reconnection
│   ├── use-agent-stream.ts           ← Agent-specific SSE (output, state)
│   ├── use-approval-stream.ts        ← Approval SSE stream
│   └── use-api.ts                    ← Fetch wrapper with auth + error handling
│
├── lib/
│   ├── api-client.ts                 ← Typed REST client (server + client)
│   ├── sse-client.ts                 ← EventSource wrapper with Last-Event-ID
│   └── format.ts                     ← Date, duration, byte formatters
│
└── styles/
    └── globals.css                    ← Tailwind directives + CSS custom properties
```

### Component Rendering Strategy

| Component       | Rendering        | Rationale                            |
| --------------- | ---------------- | ------------------------------------ |
| `nav-shell`     | Server Component | Static layout, no interactivity      |
| `agent-grid`    | Server Component | Initial fetch, passes data to cards  |
| `agent-card`    | Client Component | SSE-driven live status updates       |
| `live-output`   | Client Component | SSE streaming terminal               |
| `steer-input`   | Client Component | Form with POST mutation              |
| `approval-card` | Client Component | SSE updates + approve/reject actions |
| `vnc-viewer`    | Client Component | WebSocket + iframe embed             |
| `memory-search` | Client Component | Search input + async results         |
| `memory-editor` | Client Component | Textarea + save mutation             |
| `job-table`     | Server Component | Paginated, server-fetched            |
| `page-header`   | Server Component | Static title + breadcrumbs           |

---

## 6. Data Flow: REST Endpoints → Views

### 6.1 Endpoint → View Mapping

```
┌─────────────────────────────────────┬─────────────────────────────────┐
│ REST Endpoint                       │ Dashboard View                  │
├─────────────────────────────────────┼─────────────────────────────────┤
│ GET  /agents                        │ / (agent grid)                  │
│ GET  /agents/:id                    │ /agents/[agentId] (detail)      │
│ GET  /agents/:id/stream        [SSE]│ /agents/[agentId] (live output) │
│ POST /agents/:id/steer              │ /agents/[agentId] (steer input) │
│ POST /agents/:id/pause              │ /agents/[agentId] (controls)    │
│ POST /agents/:id/resume             │ /agents/[agentId] (controls)    │
├─────────────────────────────────────┼─────────────────────────────────┤
│ GET  /approvals                     │ /approvals, / (pending section) │
│ GET  /approvals/stream         [SSE]│ /approvals, notification bell   │
│ POST /approval/:id/decide           │ /approvals (approve/reject)     │
│ POST /jobs/:jobId/approve           │ /approvals (approve/reject)     │
│ GET  /jobs/:jobId/approvals         │ /agents/[agentId] (job detail)  │
├─────────────────────────────────────┼─────────────────────────────────┤
│ GET  /agents/:id/observe/stream-status│ /agents/[agentId]/browser     │
│ GET  /agents/:id/observe/vnc   [WS] │ /agents/[agentId]/browser (VNC) │
│ POST /agents/:id/observe/screenshot │ /agents/[agentId]/browser       │
│ GET  /agents/:id/observe/tabs       │ /agents/[agentId]/browser (tabs)│
│ GET  /agents/:id/observe/trace      │ /agents/[agentId]/browser       │
│ POST /agents/:id/observe/trace/start│ /agents/[agentId]/browser       │
│ POST /agents/:id/observe/trace/stop │ /agents/[agentId]/browser       │
│ POST /agents/:id/observe/annotate   │ /agents/[agentId]/browser       │
├─────────────────────────────────────┼─────────────────────────────────┤
│ POST /memory/sync                   │ /memory, /agents/[id]/memory    │
├─────────────────────────────────────┼─────────────────────────────────┤
│ GET  /healthz                       │ nav-shell (system health dot)   │
│ GET  /readyz                        │ nav-shell (readiness indicator) │
└─────────────────────────────────────┴─────────────────────────────────┘
```

### 6.2 Data Flow Diagram

```
                    ┌─────────────┐
                    │  Browser    │
                    │  (Next.js)  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         SSE streams   REST calls   WebSocket
              │            │            │
              ▼            ▼            ▼
    ┌─────────────────────────────────────────┐
    │         Control Plane (Fastify)         │
    │                                         │
    │  /agents/:id/stream ──► SSEManager      │
    │  /approvals/stream  ──► SSEManager      │
    │  /agents/:id/observe/vnc ──► WS Proxy   │
    │                                         │
    │  /agents ─────────────► Kysely → PG     │
    │  /approvals ──────────► Kysely → PG     │
    │  /memory/sync ────────► Qdrant Client   │
    │  /agents/:id/observe/ ► CDP Proxy → Pod │
    └─────────────┬───────────────────────────┘
                  │
         ┌────────┼────────┐
         │        │        │
         ▼        ▼        ▼
    ┌────────┐ ┌──────┐ ┌─────────────┐
    │  PG 17 │ │Qdrant│ │ Agent Pods  │
    │        │ │      │ │ ┌─────────┐ │
    │ agents │ │memory│ │ │Playwright│ │
    │ jobs   │ │vectors│ │ │ sidecar │ │
    │sessions│ │      │ │ │(VNC+CDP)│ │
    └────────┘ └──────┘ │ └─────────┘ │
                        └─────────────┘
```

### 6.3 SSE Event Routing

```
Agent SSE (/agents/:id/stream)          Approval SSE (/approvals/stream)
─────────────────────────────           ────────────────────────────────
agent:state   → agent-card status       approval:created → notification-bell
              → agent detail header                      → approval-list
agent:output  → live-output terminal    approval:decided → approval-card
agent:error   → live-output (red)                        → notification-bell
agent:complete→ agent-card + toast      approval:expired → approval-card
steer:ack     → steer-input feedback
heartbeat     → connection health

Browser SSE (same agent stream)
─────────────────────────────
browser:screenshot    → vnc-viewer overlay
browser:trace:state   → trace-controls
browser:annotation:ack→ vnc-viewer cursor feedback
```

---

## 7. Authentication Flow

```
1. User opens dashboard
2. Dashboard has no session → redirect to /login
3. User authenticates (future: OAuth, for now: API key input)
4. Control plane returns session token (UUID)
5. Token stored in httpOnly cookie
6. All REST calls include: Authorization: Bearer <session-id>
7. SSE connections include same Bearer token
8. Session validated per-request against `session` table in PG
```

For the initial scaffold, authentication is deferred — the dashboard uses
a configurable API key via environment variable (`CORTEX_API_KEY`).

---

## 8. Real-time Architecture

### SSE Connection Management

```typescript
// Client-side: one EventSource per agent, shared across components
const agentStream = new EventSource(
  `/api/agents/${agentId}/stream`,
  // Note: EventSource doesn't support custom headers natively.
  // We use a Next.js API route as a proxy that adds auth headers.
)

agentStream.addEventListener("agent:output", (e) => {
  const data = JSON.parse(e.data)
  appendToTerminal(data.output)
})

// Reconnection: browser auto-reconnects with Last-Event-ID header
// Replay buffer on server fills in missed events
```

### Next.js API Route Proxy (for SSE auth)

Since `EventSource` doesn't support custom headers, the dashboard proxies
SSE through Next.js API routes that add the `Authorization` header:

```
Browser EventSource → GET /api/agents/:id/stream (Next.js route)
                      → GET http://control-plane:4000/agents/:id/stream
                        (with Authorization: Bearer <session>)
```

---

## 9. Mobile-Responsive Strategy

| Breakpoint        | Layout                                   |
| ----------------- | ---------------------------------------- |
| `< 640px` (sm)    | Single column, bottom nav, stacked cards |
| `640–1024px` (md) | Two-column grid, collapsible sidebar     |
| `> 1024px` (lg)   | Three-column grid, persistent sidebar    |

**Key mobile adaptations:**

- Agent grid collapses to a scrollable list
- Approval actions use full-width buttons
- Browser observation shows screenshot-only mode (no VNC on mobile)
- Steering input uses a bottom sheet
- Navigation moves to a bottom tab bar

---

## 10. Deployment

### Dockerfile

```dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
RUN corepack enable pnpm && pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @cortex/dashboard build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system cortex && adduser --system --ingroup cortex cortex
COPY --from=builder /app/packages/dashboard/.next/standalone ./
COPY --from=builder /app/packages/dashboard/.next/static ./.next/static
COPY --from=builder /app/packages/dashboard/public ./public
USER cortex
EXPOSE 3100
CMD ["node", "server.js"]
```

### K8s Resource Allocation

```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi
```

### Environment Variables

| Variable             | Description                 | Default                     |
| -------------------- | --------------------------- | --------------------------- |
| `CORTEX_API_URL`     | Control plane internal URL  | `http://control-plane:4000` |
| `CORTEX_API_KEY`     | API key for initial auth    | (required)                  |
| `NEXT_PUBLIC_WS_URL` | WebSocket URL for VNC proxy | `ws://localhost:4000`       |

---

## 11. Open Questions / Future Work

| Item                                | Status               | Notes                                           |
| ----------------------------------- | -------------------- | ----------------------------------------------- |
| OAuth / OIDC login                  | Deferred             | Use API key for MVP                             |
| Qdrant direct search from dashboard | Deferred             | Needs new REST endpoint on control plane        |
| Job retry from dashboard            | Design ready         | Needs `POST /jobs/:id/retry` endpoint           |
| Content pipeline ("AI Pulse")       | Design ready         | Needs content-specific REST endpoints           |
| Dark mode                           | Included in scaffold | Tailwind `dark:` variant with system preference |
| Keyboard shortcuts                  | Deferred             | Consider `j/k` nav, `a/r` approve/reject        |
| Notifications (push/audio)          | Deferred             | Browser Notification API for approvals          |

---

## 12. Implementation Phases

### Phase 1 — Scaffold (this ticket)

- [x] Design document
- [x] Next.js app structure with App Router
- [x] Tailwind CSS configuration
- [x] Component file scaffolds (empty exports)
- [x] API client types
- [x] SSE hook scaffolds

### Phase 2 — Core Views

- [ ] Agent grid with real data
- [ ] Agent detail + live output streaming
- [ ] Approval queue with SSE updates
- [ ] Steering input

### Phase 3 — Observation + Memory

- [ ] Browser observation (noVNC embed)
- [ ] Memory explorer (search + edit)
- [ ] Memory sync trigger

### Phase 4 — Pipeline + Polish

- [ ] Content pipeline dashboard
- [ ] Job history + retry
- [ ] Mobile responsiveness pass
- [ ] Authentication flow
- [ ] Dark mode polish
