# Operator Dashboard — Design Document

**Issue:** #267
**Status:** Proposed
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-07
**Depends on:** [Operator Visibility](./operator-visibility.md) (#265), [Agent Capability Model](./agent-capabilities.md) (#264), [Agent Lifecycle & Resilience](./agent-lifecycle.md) (#266)

---

## 1. Problem Statement

Cortex Plane has a working control-plane API and a dashboard with agent/job/approval views, but the operator experience is fragmented:

1. **No unified channel management.** Telegram and Discord channel bindings exist (`agent_channel_binding`), but there is no standalone channel inventory. An operator cannot see all configured channels at a glance, test connectivity, or toggle channels without navigating to individual agents.

2. **No MCP skill configuration surface.** MCP servers can be managed via the API and the existing `/mcp-servers` page, but there is no way to browse available tools per server, control which agents can use which tools, or view tool health from the dashboard.

3. **No credential taxonomy in the UI.** The Settings page shows a flat list of LLM providers. There is no visual separation of LLM credentials, user-service OAuth tokens, and tool secrets — despite the backend supporting all three via `credential_class`.

4. **No wiring diagram.** The relationship between channels, agents, tools, and credentials is implicit. An operator must mentally reconstruct the data flow: which channel feeds which agent, which agent uses which tools, and which credentials back those tools.

5. **No onboarding path.** A first-time operator faces an empty dashboard with no guidance on the minimum setup required to get an agent responding on a channel.

### North Star

An operator opens the dashboard, sees the full state of their platform at a glance, and can wire up a new agent with MCP tools and a chat channel in under 5 minutes — without reading docs.

---

## 2. Design Principles

1. **Complete configuration surface.** Every capability Cortex Plane has must be visible and configurable from the UI. No hidden env vars, no CLI-only config.
2. **Canonical CRUD pattern.** Every configuration entity follows the same UX pattern: list → add → detail → edit → delete. Consistency reduces cognitive load.
3. **Progressive disclosure.** Summary views by default; drill down for detail. The home page shows the wiring diagram. Individual pages show entity-specific configuration.
4. **Chat-first, dashboard-second.** The dashboard is the instrument panel, not the primary interaction surface. It should confirm what's working, surface what's broken, and let the operator fix it.
5. **Health everywhere.** Every entity (channel, MCP server, credential, agent) shows a health indicator. Green means working. Anything else demands attention.

---

## 3. Information Architecture

### 3.1 Navigation

The sidebar navigation expands from its current state to include the full configuration surface:

```
Dashboard (home)          — wiring diagram + fleet summary
Agents                    — agent list, detail, configuration
  └─ [Agent] → Settings   — model, channels, tools, guardrails
MCP Servers               — (existing) server list + tool inventory
Approvals                 — (existing) approval queue
Jobs                      — (existing) job history
Memory                    — (existing) vector memory
Pulse                     — (existing) system health
Settings                  — (restructured) sub-pages:
  ├─ Channels             — channel inventory + health
  ├─ Credentials          — three-section credential manager
  └─ Account              — user profile (existing content)
```

**Changes from current nav:**
- Settings gains sub-navigation with tabs: **Channels**, **Credentials**, **Account**.
- The current Settings page content (account info + provider list) moves to **Settings → Credentials** and **Settings → Account**.
- Agent detail page gains a **Settings** tab for model binding, channel binding, tool binding, and guardrails.
- Dashboard home page is redesigned with the wiring diagram.

### 3.2 Page Inventory

| Route | Page | Status | Description |
|-------|------|--------|-------------|
| `/` | Dashboard Home | **Redesign** | Wiring diagram + fleet summary + recent alerts |
| `/agents` | Agent List | Existing | Add health badge, cost summary per card |
| `/agents/:id` | Agent Detail | **Extend** | Add Settings tab (model, channels, tools, guardrails) |
| `/mcp-servers` | MCP Server List | **Extend** | Add tool inventory expansion, health badges |
| `/mcp-servers/:id` | MCP Server Detail | **Extend** | Tool list with input schemas, agent bindings |
| `/settings` | Settings Shell | **Restructure** | Tab layout: Channels, Credentials, Account |
| `/settings?tab=channels` | Channel Manager | **New** | Channel list + add/edit/test/toggle |
| `/settings?tab=credentials` | Credential Manager | **Redesign** | Three-section layout (LLM, user service, tool secrets) |
| `/settings?tab=account` | Account | Existing | Current account info section |
| `/approvals` | Approval Queue | Existing | No changes |
| `/jobs` | Job History | Existing | No changes |
| `/memory` | Memory | Existing | No changes |
| `/pulse` | System Pulse | Existing | No changes |

---

## 4. Configuration Surfaces

### 4.1 Channels (Settings → Channels)

**Data model:** `agent_channel_binding` table exists but is agent-scoped. A standalone channel concept is needed.

#### Current State
- `agent_channel_binding` stores: `agent_id`, `channel_type` (telegram/discord), `chat_id`, `is_default`.
- Telegram/Discord adapters read tokens from env vars (`CHANNEL_TELEGRAM_BOT_TOKEN`, `CHANNEL_DISCORD_TOKEN`).
- No channel health tracking or test-connection capability.
- No standalone channel entity — channels only exist as bindings on agents.

#### Proposed: `channel` Table

A new `channel` table represents a configured communication channel independent of any agent:

```sql
CREATE TABLE channel (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  channel_type    TEXT NOT NULL,                       -- telegram, discord, whatsapp, slack, web
  config          JSONB NOT NULL DEFAULT '{}',         -- type-specific config (encrypted sensitive fields)
  status          TEXT NOT NULL DEFAULT 'PENDING',     -- PENDING, ACTIVE, ERROR, DISABLED
  error_message   TEXT,
  last_health_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `agent_channel_binding` table adds a `channel_id` FK to link agents to channels (instead of raw `chat_id`).

#### Config Schemas per Channel Type

| Type | Config Fields | Sensitive |
|------|--------------|-----------|
| `telegram` | `botToken`, `webhookUrl`, `allowedChatIds` | `botToken` |
| `discord` | `botToken`, `guildId`, `allowedChannelIds` | `botToken` |
| `slack` | `botToken`, `appId`, `signingSecret` | `botToken`, `signingSecret` |
| `whatsapp` | `apiUrl`, `apiToken`, `phoneNumberId` | `apiToken` |
| `web` | `corsOrigins`, `rateLimitRpm` | — |

Sensitive fields are encrypted with the same AES-256-GCM scheme used by credential storage.

#### API Contract

```
POST   /channels                — Create channel
GET    /channels                — List channels (?status, ?type)
GET    /channels/:id            — Get channel detail (with bound agents)
PUT    /channels/:id            — Update channel
DELETE /channels/:id            — Disable + delete channel
POST   /channels/:id/test       — Test connectivity (send probe, return result)
```

#### UI Layout

```
┌─ Settings → Channels ─────────────────────────────────┐
│                                                         │
│  [+ Add Channel]                                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ● Telegram — @cortex_bot       ACTIVE    [Edit]  │  │
│  │   3 agents bound · Last healthy 2m ago           │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ ● Discord — Cortex Server      ACTIVE    [Edit]  │  │
│  │   1 agent bound · Last healthy 1m ago            │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ ▲ Slack — #ops-channel         ERROR     [Edit]  │  │
│  │   0 agents bound · Token expired                 │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌─ Add Channel Dialog ─────────────────────────────┐  │
│  │ Type: [Telegram ▾]                                │  │
│  │ Name: [________________]                          │  │
│  │ Bot Token: [________________]                     │  │
│  │ Webhook URL: [________________] (optional)        │  │
│  │                          [Cancel] [Test & Save]   │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Key interactions:**
- **Test & Save**: POSTs to `/channels/:id/test` before saving. Shows result inline (green check or red error).
- **Enable/disable toggle**: PUTs `status: DISABLED` / `status: PENDING` (re-probes on enable).
- **Edit**: Opens inline form with current config pre-filled. Sensitive fields show masked values.
- **Health indicator**: `●` green (ACTIVE), `▲` yellow (PENDING/ERROR), `○` grey (DISABLED).

#### Acceptance Criteria
- [ ] Operator can add, edit, test, enable/disable, and delete channels from the UI.
- [ ] Channel health status refreshes on page load.
- [ ] Bound agent count shown per channel.
- [ ] Sensitive config fields encrypted at rest, masked in API responses.

---

### 4.2 MCP Skills / Tools (MCP Servers page — extended)

#### Current State
- `/mcp-servers` page lists MCP servers with status badges.
- `/mcp-servers/:id` detail page exists but is minimal.
- Backend supports CRUD, refresh, and tool discovery (`mcp_server_tool`).
- `agent_tool_binding` table exists (migration 018) but no UI to manage it.

#### Proposed Extensions

**Server list page enhancements:**
- Expand each server row to show its tool count and a tool preview list.
- Add a health dashboard: status, last probe time, error count (from `agent_event`).
- Show which agents are bound to each server (via `agent_tool_binding`).

**Server detail page enhancements:**
- **Tool inventory**: Full list of tools from `mcp_server_tool` with name, description, input schema.
- **Per-tool toggle**: Enable/disable individual tools for the platform (sets `enabled` on `mcp_server_tool`).
- **Agent bindings**: List which agents can use this server's tools, with link to agent settings.
- **Configuration panel**: Edit connection settings, API keys (encrypted), rate limits.

#### API Extensions

```
GET    /mcp-servers/:id/tools                — List tools (already available via GET /:id response)
PUT    /mcp-servers/:id/tools/:toolId        — Update tool metadata (enable/disable, description override)
GET    /mcp-servers/:id/bindings             — List agent bindings for this server
```

#### UI Layout — Server Detail

```
┌─ MCP Server: brave-search ──────────────────────────────┐
│ Status: ACTIVE ●  │  Transport: streamable-http          │
│ Last probe: 30s ago  │  Tools: 3                         │
│ Agents bound: 2 (Modulus, Outreach)                      │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─ Tools ───────────────────────────────────────────┐  │
│  │ ✓ brave_web_search     Search the web       [···] │  │
│  │   Input: { query: string, count?: number }        │  │
│  │                                                    │  │
│  │ ✓ brave_local_search   Search local results [···] │  │
│  │   Input: { query: string, location: string }      │  │
│  │                                                    │  │
│  │ ○ brave_news_search    Search news (disabled)[···]│  │
│  │   Input: { query: string, freshness?: string }    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─ Connection ──────────────────────────────────────┐  │
│  │ URL: https://mcp.brave.com/v1                     │  │
│  │ API Key: sk-br...***  [Rotate]                    │  │
│  │ Rate limit: 100 req/min                           │  │
│  │                                [Edit] [Refresh]   │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

#### Acceptance Criteria
- [ ] Tool list visible per MCP server with input schema preview.
- [ ] Individual tools can be enabled/disabled.
- [ ] Agent bindings visible per server.
- [ ] Health probe status and error count shown.

---

### 4.3 Agent Configuration (Agent Detail → Settings tab)

#### Current State
- Agent CRUD via `PUT /agents/:id` accepts `model_config`, `skill_config`, `resource_limits` as JSON blobs.
- Agent detail page shows overview, sessions, jobs tabs.
- No UI for editing agent configuration beyond the initial create form.
- `agent_credential_binding` and `agent_tool_binding` tables exist but no UI.

#### Proposed: Settings Tab

A new **Settings** tab on the agent detail page with sections:

**Section 1: Model Binding**
- Select LLM provider (from credentials of class `llm_provider`).
- Select model (populated from provider's model list).
- System prompt editor (textarea with syntax highlighting for `{{variables}}`).

**Section 2: Channel Binding**
- Multi-select from configured channels (from `channel` table).
- Shows current bindings with default indicator.
- Add/remove bindings inline.

**Section 3: Tool Binding**
- Browse available MCP servers and their tools.
- Per-tool toggle with approval policy selector (`auto`, `always_approve`, `conditional`).
- Rate limit and cost budget per tool.
- Data scope injection config (`_cortex_scope`).

**Section 4: Guardrails**
- Token budget (per job, per session, per day).
- Max tool calls per turn.
- Circuit breaker thresholds (consecutive failures, rate limit).
- Context budget limits (per component).

#### API Extensions

```
GET    /agents/:id/tool-bindings             — List tool bindings
POST   /agents/:id/tool-bindings             — Create tool binding
PUT    /agents/:id/tool-bindings/:bindingId  — Update binding (approval policy, rate limit, etc.)
DELETE /agents/:id/tool-bindings/:bindingId  — Remove tool binding
```

Agent credential bindings already have routes at `/agents/:id/credentials`.

#### UI Layout

```
┌─ Agent: Modulus ──────────────────────────────────────────┐
│ [Overview] [Sessions] [Jobs] [Capabilities] [Ops] [Settings] │
├───────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─ Model ─────────────────────────────────────────────┐ │
│  │ Provider: [Anthropic ▾]   Model: [claude-sonnet-4-6 ▾] │
│  │                                                      │ │
│  │ System Prompt:                                       │ │
│  │ ┌────────────────────────────────────────────────┐  │ │
│  │ │ You are Modulus, an operations agent for...     │  │ │
│  │ │ {{agent_name}} handles scheduling and...       │  │ │
│  │ └────────────────────────────────────────────────┘  │ │
│  │                                           [Save]    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Channels ──────────────────────────────────────────┐ │
│  │ ✓ Telegram — @cortex_bot           [Default] [×]   │ │
│  │ ✓ Discord — Cortex Server                    [×]   │ │
│  │                                   [+ Bind Channel] │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Tools ─────────────────────────────────────────────┐ │
│  │ brave-search                                        │ │
│  │   ✓ brave_web_search       auto         100/min    │ │
│  │   ✓ brave_local_search     auto         100/min    │ │
│  │ slack                                               │ │
│  │   ✓ chat_postMessage       always_approve  50/min  │ │
│  │   ○ users_list             (not bound)             │ │
│  │                                    [+ Bind Tool]    │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Guardrails ────────────────────────────────────────┐ │
│  │ Token budget:  Job [200k]  Session [1M]  Day [5M]  │ │
│  │ Max tool calls per turn: [40]                       │ │
│  │ Circuit breaker: [3] consecutive failures           │ │
│  │ Context budget: [128k] chars                        │ │
│  │                                           [Save]    │ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

#### Acceptance Criteria
- [ ] Operator can change model, system prompt, channels, tools, and guardrails from the Settings tab.
- [ ] Changes persist via the existing `PUT /agents/:id` and new tool-binding endpoints.
- [ ] Tool bindings show approval policy and rate limit inline.
- [ ] Guardrail values pre-populated from current `resource_limits`.

---

### 4.4 Credentials (Settings → Credentials)

#### Current State
- Settings page shows a flat list of LLM providers with connect/add-key buttons.
- Backend `CredentialService` supports `credential_class`: `llm_provider`, `mcp_server`, `tool_specific`, `user_service`.
- `SUPPORTED_PROVIDERS` array includes google-workspace, github-user, slack-user (user_service) and brave (tool_specific).
- OAuth popup flow and API key paste flow both implemented.

#### Proposed: Three-Section Layout

Restructure the credential page into three sections matching the credential taxonomy (#263):

```
┌─ Settings → Credentials ──────────────────────────────────┐
│                                                             │
│  ┌─ LLM Providers ────────────────────────────────────┐   │
│  │ ● Anthropic        active    sk-ant...*** [Disconnect]│  │
│  │ ○ OpenAI           —                   [Add Key]    │   │
│  │ ○ Google Antigravity —                 [Connect]    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─ User Services ────────────────────────────────────┐   │
│  │ ● Google Workspace  active   Expires in 28d [Refresh]│  │
│  │ ● GitHub           active   Expires in 45d [Refresh]│   │
│  │ ○ Slack            —                    [Connect]   │   │
│  │                                                      │   │
│  │ Agents using: Modulus (Google, GitHub), Outreach     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─ Tool Secrets ─────────────────────────────────────┐   │
│  │ ● brave-api-key     active    sk-br...***          │   │
│  │   Used by: brave-search MCP server                  │   │
│  │ ● twilio-auth       active    AC...***              │   │
│  │   Used by: twilio-sms MCP server                    │   │
│  │                                  [+ Add Tool Secret]│   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Each credential shows: status, agent bindings, expiry     │
└─────────────────────────────────────────────────────────────┘
```

**Enhancements over current UI:**
- Group by `credential_class`.
- Show which agents use each credential (from `agent_credential_binding`).
- Show expiry/refresh status for OAuth tokens.
- Tool secrets section (admin-only) with the MCP server they're bound to.

#### API Extensions

The existing credential routes are sufficient. The UI needs to:
- Filter `GET /credentials` by `?class=llm_provider`, `?class=user_service`, `?class=tool_specific`.
- Show `agent_credential_binding` data inline (can be fetched with a join or separate call).

#### Acceptance Criteria
- [ ] Credentials grouped by class in three visual sections.
- [ ] Agent usage shown per credential.
- [ ] Expiry status visible for OAuth tokens.
- [ ] Tool secrets section visible only to admin/operator roles.

---

### 4.5 Wiring Diagram (Dashboard Home)

#### Current State
- Dashboard home shows KPI cards (active agents, pending jobs, total sessions) and a recent activity list.
- No visualization of the channel → agent → tool → credential data flow.

#### Proposed: Cockpit View

The dashboard home page adds a visual wiring diagram showing the full platform topology:

```
┌─ Dashboard ─────────────────────────────────────────────────┐
│                                                               │
│  ┌─ Fleet Summary ─────────────────────────────────────┐    │
│  │  Agents: 4 active, 1 degraded  │  Cost today: $12.40 │   │
│  │  Channels: 3 connected         │  MCP Servers: 5 up  │   │
│  │  Pending approvals: 2          │  Jobs: 12 today     │   │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Wiring Diagram ────────────────────────────────────┐    │
│  │                                                      │    │
│  │  CHANNELS          AGENTS            TOOLS           │    │
│  │  ┌──────────┐     ┌──────────┐     ┌────────────┐  │    │
│  │  │Telegram ●├────→│Modulus ● ├────→│brave-search│  │    │
│  │  └──────────┘  ┌─→│          ├────→│slack       │  │    │
│  │  ┌──────────┐  │  └──────────┘     └────────────┘  │    │
│  │  │Discord  ●├──┘                                    │    │
│  │  └──────────┘     ┌──────────┐     ┌────────────┐  │    │
│  │  ┌──────────┐     │Outreach ●├────→│gmail       │  │    │
│  │  │Slack    ▲├─ ─ ─│          │     └────────────┘  │    │
│  │  └──────────┘     └──────────┘                      │    │
│  │                                                      │    │
│  │  ● healthy   ▲ degraded   ○ disconnected            │    │
│  │  ─── active binding   ─ ─ ─ broken binding          │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Recent Alerts ─────────────────────────────────────┐    │
│  │ ▲ Slack channel — token expired (2h ago)             │    │
│  │ ● Modulus — budget warning: 80% of daily limit       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Recent Activity ───────────────────────────────────┐    │
│  │ (existing activity feed — jobs, sessions, etc.)      │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Implementation approach:**
- The wiring diagram is a React component that queries three endpoints: `GET /channels`, `GET /agents`, `GET /mcp-servers`.
- Renders as a three-column layout with SVG connection lines (or a simple CSS-based layout with colored borders).
- Each node is clickable — navigates to the detail page.
- Broken connections highlighted with dashed lines and warning colors.
- Health status aggregated from each entity's status field.

**Complexity note:** A full graph visualization (D3, React Flow) is a stretch goal. The MVP can use a simpler three-column card layout with status indicators and textual binding lists, without SVG lines. The visual connection between entities is conveyed through the binding lists on each card.

#### Acceptance Criteria
- [ ] Dashboard home shows fleet summary KPIs.
- [ ] Wiring diagram displays channels, agents, and tools with health status.
- [ ] Broken connections (misconfigured channel, expired credential, unhealthy MCP) highlighted.
- [ ] Each entity in the diagram links to its detail page.
- [ ] Recent alerts section shows critical events.

---

## 5. Onboarding Flow

### 5.1 First-Time Experience

When an operator first opens the dashboard and no agents are configured, the home page shows a guided setup wizard instead of the wiring diagram:

```
┌─ Welcome to Cortex Plane ───────────────────────────────────┐
│                                                               │
│  Let's get your first agent running. This takes about        │
│  5 minutes.                                                   │
│                                                               │
│  Step 1 of 4: Connect an LLM Provider                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Your agent needs an LLM to think. Connect a provider: │   │
│  │                                                        │   │
│  │ [● Anthropic]  [○ OpenAI]  [○ Google Antigravity]     │   │
│  │                                                        │   │
│  │ API Key: [sk-ant-...________________]                  │   │
│  │                                                        │   │
│  │                                         [Next →]       │   │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ○ Step 2: Create an Agent                                    │
│  ○ Step 3: Add a Channel                                      │
│  ○ Step 4: Send a Test Message                                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Wizard Steps

| Step | Action | Minimum Input | What Happens |
|------|--------|--------------|-------------|
| 1. Connect LLM | Select provider, paste API key or OAuth connect | Provider + key | `POST /credentials/api-key` |
| 2. Create Agent | Name, role, select model from connected provider | Name + model | `POST /agents` + `POST /agents/:id/credentials` |
| 3. Add Channel | Select type, fill type-specific config, test | Type + config | `POST /channels` + `POST /agents/:id/channels` |
| 4. Test Message | Send a test message through the bound channel | Message text | `POST /agents/:id/chat` or channel-specific send |

**Post-wizard:** The wiring diagram appears with the newly created agent, channel, and LLM binding. The operator sees a working, healthy system.

### 5.3 Empty States

Each configuration page shows a helpful empty state when no entities exist:

- **Channels:** "No channels configured. Add a channel to connect your agents to Telegram, Discord, or Slack."
- **MCP Servers:** "No MCP servers connected. Add an MCP server to give your agents tools and skills."
- **Credentials (Tool Secrets):** "No tool secrets stored. MCP servers that require API keys will need tool secrets."

#### Acceptance Criteria
- [ ] Wizard displayed when no agents exist.
- [ ] Each step validates before proceeding (e.g., API key verified).
- [ ] Wizard can be skipped/dismissed.
- [ ] Empty states shown on all configuration pages.

---

## 6. Design System Component Mapping

### 6.1 Canonical CRUD Component

All configuration entities use a shared layout pattern:

```
EntityListPage
├── PageHeader (title, description, [+ Add] button)
├── FilterBar (optional: status filter, search)
├── EntityCard[] (repeating card for each entity)
│   ├── StatusBadge (●/▲/○ with color)
│   ├── EntityName + subtitle
│   ├── MetadataRow (key-value pairs: type, last used, binding count)
│   └── ActionButtons ([Edit] [Delete] or entity-specific)
└── EmptyState (when no entities exist)

EntityDetailPage
├── PageHeader (entity name, status badge, back link)
├── TabBar (entity-specific tabs)
├── DetailSection[] (repeating section per config area)
│   ├── SectionHeader (title, optional [Edit] toggle)
│   └── SectionContent (key-value display or edit form)
└── DangerZone (delete/archive action, red-bordered)
```

### 6.2 Shared UI Components

| Component | Usage | Location |
|-----------|-------|----------|
| `StatusBadge` | Health indicator on all entities | Channels, MCP servers, credentials, agents |
| `EntityCard` | List item with status + metadata | All list pages |
| `ConfigSection` | Bordered section with header and content | All detail/settings pages |
| `InlineForm` | Form that replaces display content on edit | Channel config, credential entry, guardrails |
| `ConfirmDialog` | Confirmation before destructive actions | Delete channel, disconnect credential |
| `TestConnectionButton` | Trigger test + show result inline | Channel add/edit |
| `WiringDiagram` | Three-column topology view | Dashboard home |
| `SetupWizard` | Multi-step onboarding flow | Dashboard home (first-time) |
| `EmptyState` | Helpful message when no entities | All list pages |

### 6.3 Existing Components to Reuse

| Existing Component | Location | Reuse For |
|-------------------|----------|-----------|
| `EntityCard` pattern | `agents/agent-card.tsx` | All entity list cards |
| `StatusBadge` | `jobs/job-status-badge.tsx` | All entity status indicators |
| `EmptyState` | `layout/empty-state.tsx` | All empty states |
| `Skeleton` | `layout/skeleton.tsx` | All loading states |
| `PageHeader` | `layout/page-header.tsx` | All page headers |
| OAuth popup flow | `settings/page.tsx` | Credential connection (already exists) |

---

## 7. Validation UX

### 7.1 Health Badges

Every entity displays a status badge using a consistent color scheme:

| Status | Color | Icon | Meaning |
|--------|-------|------|---------|
| `ACTIVE` / `healthy` | Green | `●` | Working normally |
| `PENDING` | Blue | `◌` | Initializing / probing |
| `DEGRADED` | Yellow | `▲` | Partially working, needs attention |
| `ERROR` | Red | `✕` | Failed, requires action |
| `DISABLED` | Grey | `○` | Manually disabled |

### 7.2 Broken Connection Detection

The wiring diagram and entity cards detect broken connections:

| Break Type | Detection | Display |
|-----------|-----------|---------|
| Expired credential | `provider_credential.expires_at < now()` | Red badge on credential, dashed line in diagram |
| Unhealthy MCP server | `mcp_server.status = ERROR` | Red badge on server, dashed line to agent |
| Disconnected channel | `channel.status = ERROR` | Red badge on channel, dashed line to agent |
| Unbound agent | Agent with no channel bindings | Warning badge on agent card |
| Missing credential | Agent bound to tool but no matching credential | Warning in agent Settings tab |

### 7.3 Diagnostics

Each entity detail page includes a diagnostics section at the bottom:

```
┌─ Diagnostics ──────────────────────────────────────────┐
│ ✓ Connection healthy (last check: 30s ago)              │
│ ✓ Credentials valid (expires in 28 days)                │
│ ✕ Rate limit approaching: 85% of 100 req/min           │
│ ✓ 3 agents bound                                        │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Agent Self-Configuration

### 8.1 Problem

If an agent can configure itself (e.g., register a new MCP tool, connect a channel), the dashboard must reflect those changes in real time.

### 8.2 Approach

1. **Event-driven updates.** Agent self-configuration actions emit events via `AgentEventEmitter` (#265). The dashboard subscribes to the SSE activity stream.
2. **Optimistic refresh.** When the dashboard receives a `tool_binding_created` or `channel_binding_created` event, it refetches the relevant entity list.
3. **Notification.** The notification bell (already in the top nav) shows a badge when agent-initiated configuration changes occur. Clicking it shows a list of recent changes with links to the affected entities.
4. **Audit trail.** All self-configuration actions are logged in `capability_audit_log` (#264). The agent detail page shows these in the activity stream.

### 8.3 Guardrails

Agent self-configuration is gated by the capability model (#264):
- Agents cannot bind tools they don't have permission for.
- Agents cannot create credentials or channels.
- Agents can only modify their own bindings, within the scope defined by `agent_tool_binding.data_scope`.

---

## 9. Epic Breakdown — Implementation Tickets

### Dependency Graph

```
T1 (migration: channel table)
├── T2 (channel API routes)
│   ├── T4 (channel manager UI)
│   └── T6 (agent channel binding UI)
├── T3 (channel health probe)
│   └── T4

T5 (settings page restructure: tabs)
├── T4 (channel manager UI)
├── T7 (credential manager UI redesign)

T8 (agent settings tab)
├── T6 (channel binding UI)
├── T9 (tool binding UI)

T10 (MCP server detail enhancements)
├── T9 (tool binding UI)

T11 (dashboard home redesign: wiring diagram)
├── T2, T10

T12 (onboarding wizard)
├── T2, T4, T7, T8
```

### Ticket List

| # | Ticket | Size | Dependencies | Status |
|---|--------|------|-------------|--------|
| T1 | DB migration — `channel` table + `agent_channel_binding.channel_id` FK | S | None | Open |
| T2 | Channel CRUD API routes (`/channels`) | M | T1 | Open |
| T3 | Channel health probe service (test connectivity per channel type) | M | T1 | Open |
| T4 | Settings → Channels page (channel manager UI) | M | T2, T3, T5 | Open |
| T5 | Settings page restructure — tab layout (Channels, Credentials, Account) | S | None | Open |
| T6 | Agent Settings tab — channel binding section | S | T2, T8 | Open |
| T7 | Settings → Credentials page — three-section redesign | M | T5 | Open |
| T8 | Agent detail page — add Settings tab (model, guardrails) | M | None | Open |
| T9 | Agent Settings tab — tool binding section (agent_tool_binding CRUD UI) | M | T8, T10 | Open |
| T10 | MCP Server detail — tool inventory, agent bindings, health | M | None | Open |
| T11 | Dashboard home — wiring diagram + fleet summary redesign | L | T2, T10 | Open |
| T12 | Onboarding wizard — guided first-time setup flow | M | T2, T4, T7, T8 | Open |

### Critical Path

```
T1 → T2 → T4 → T11   (channels → wiring diagram)
T5 → T7              (settings restructure → credential redesign)
T8 → T9              (agent settings → tool binding)
```

**Parallel tracks:**
- Track A: T1 → T2 → T3 → T4 (channels backend + UI)
- Track B: T5 → T7 (settings restructure + credentials)
- Track C: T8 → T6, T9 (agent settings)
- Track D: T10 (MCP enhancements, independent)
- Track E: T11 (wiring diagram, depends on A + D)
- Track F: T12 (wizard, depends on A + B + C)

### Ticket Details

#### T1 — DB migration: `channel` table

**Scope:** New migration file, Kysely type updates.

**Migration:**
```sql
CREATE TABLE channel (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  channel_type    TEXT NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING',
  error_message   TEXT,
  last_health_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_channel_binding
  ADD COLUMN channel_id UUID REFERENCES channel(id) ON DELETE SET NULL;
```

**Files:** `migrations/024_channel_table.ts`, `src/db/types.ts`
**Acceptance:** Migration runs cleanly. Existing `agent_channel_binding` rows retain their `chat_id` values (channel_id is nullable for backward compat).

#### T2 — Channel CRUD API routes

**Scope:** `src/routes/channels.ts` — new route file.

**Endpoints:**
```
POST   /channels            — Create channel
GET    /channels            — List (?status, ?type, pagination)
GET    /channels/:id        — Detail (with bound agents)
PUT    /channels/:id        — Update
DELETE /channels/:id        — Disable + delete
POST   /channels/:id/test   — Test connectivity
```

**Files:** `src/routes/channels.ts`, `src/app.ts` (register route), `src/__tests__/channels.test.ts`
**Acceptance:** Full CRUD with auth. Test endpoint returns `{ success: boolean, latencyMs: number, error?: string }`. Config sensitive fields encrypted. 12+ tests.

#### T3 — Channel health probe service

**Scope:** `src/channels/channel-health-probe.ts` — per-type connectivity test.

**Implementation:** Probe functions per channel type (Telegram `getMe`, Discord gateway check, etc.). Called by `POST /channels/:id/test` and scheduled health check.

**Files:** `src/channels/channel-health-probe.ts`, `src/__tests__/channel-health-probe.test.ts`
**Acceptance:** Probe returns `{ healthy: boolean, latencyMs: number, error?: string }`. Telegram and Discord probes implemented. 8+ tests.

#### T4 — Settings → Channels page

**Scope:** New channel manager UI within the restructured settings page.

**Files:** `packages/dashboard/src/components/channels/`, `packages/dashboard/src/app/settings/page.tsx`
**Acceptance:** Channel list with status, add/edit dialog, test-on-save, enable/disable toggle. Empty state when no channels.

#### T5 — Settings page restructure

**Scope:** Add tab navigation to settings page (Channels, Credentials, Account).

**Files:** `packages/dashboard/src/app/settings/page.tsx`
**Acceptance:** Three tabs. URL updates with `?tab=` param. Account tab contains existing content. Deep-linkable.

#### T6 — Agent Settings: channel binding section

**Scope:** Channel binding multi-select within agent settings tab.

**Files:** `packages/dashboard/src/components/agents/agent-channel-bindings.tsx`
**Acceptance:** Add/remove channel bindings. Shows channel health inline. Default channel toggle.

#### T7 — Settings → Credentials: three-section redesign

**Scope:** Restructure credential list into LLM Providers, User Services, Tool Secrets sections.

**Files:** `packages/dashboard/src/app/settings/page.tsx` (or extracted components)
**Acceptance:** Three visual sections. Agent usage per credential. Expiry shown for OAuth tokens. Tool secrets admin-only.

#### T8 — Agent detail: Settings tab

**Scope:** New Settings tab on agent detail page with model binding and guardrails sections.

**Files:** `packages/dashboard/src/app/agents/[agentId]/page.tsx`, `packages/dashboard/src/components/agents/agent-settings.tsx`
**Acceptance:** Model selector, system prompt editor, guardrail inputs. Save persists via `PUT /agents/:id`.

#### T9 — Agent Settings: tool binding section

**Scope:** Tool binding CRUD UI with approval policy and rate limit controls.

**Files:** `packages/dashboard/src/components/agents/agent-tool-bindings.tsx`, `src/routes/agent-tool-bindings.ts` (if not yet exists)
**Acceptance:** Browse available tools, bind/unbind, set approval policy per tool. Shows MCP server health.

#### T10 — MCP Server detail enhancements

**Scope:** Extend MCP server detail page with tool inventory, agent bindings, health dashboard.

**Files:** `packages/dashboard/src/app/mcp-servers/[id]/page.tsx`, `packages/dashboard/src/components/mcp/`
**Acceptance:** Tool list with input schemas. Per-tool enable/disable. Agent binding list. Health probe status.

#### T11 — Dashboard home: wiring diagram

**Scope:** Redesign dashboard home with fleet summary and three-column wiring diagram.

**Files:** `packages/dashboard/src/app/page.tsx`, `packages/dashboard/src/components/wiring-diagram.tsx`
**Acceptance:** Three-column layout (channels → agents → tools). Health badges. Broken connections highlighted. Each node links to detail page. Recent alerts section.

#### T12 — Onboarding wizard

**Scope:** Guided first-time setup flow displayed when no agents exist.

**Files:** `packages/dashboard/src/components/onboarding/`, `packages/dashboard/src/app/page.tsx`
**Acceptance:** 4-step wizard (LLM → Agent → Channel → Test). Each step validates. Dismissable. Shows wiring diagram after completion.

---

## 10. Answers to Spike Questions (#267)

### Information Architecture

| # | Question | Answer |
|---|----------|--------|
| 1 | How do we organize without overwhelming? | Progressive disclosure: home page shows wiring diagram summary, drill into entity pages for detail. Settings uses tabs to separate channels, credentials, account. (§3) |
| 2 | First-time operator experience? | 4-step onboarding wizard: Connect LLM → Create Agent → Add Channel → Test Message. Minimum viable setup in under 5 minutes. (§5) |

### Design System

| # | Question | Answer |
|---|----------|--------|
| 3 | Component mapping? | Reuse existing agent-card, status-badge, empty-state, page-header, skeleton patterns. New shared components: ConfigSection, InlineForm, TestConnectionButton. (§6) |
| 4 | Canonical CRUD component? | EntityListPage + EntityDetailPage pattern. All config entities use: list → add → detail → edit → delete with consistent card layout. (§6.1) |

### Validation UX

| # | Question | Answer |
|---|----------|--------|
| 5 | How to show misconfiguration? | Health badges on every entity (green/yellow/red/grey). Wiring diagram shows broken connections with dashed lines. Per-entity diagnostics section. (§7) |

### Agent Self-Configuration

| # | Question | Answer |
|---|----------|--------|
| 6 | How does UI reflect agent-initiated changes? | SSE event subscription triggers optimistic refresh. Notification bell shows config-change events. Capability audit log provides full trail. (§8) |
