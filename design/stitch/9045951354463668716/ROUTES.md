# Stitch Screen → Route Mapping

> Maps Stitch design screens to Cortex Plane dashboard routes.
> Each route lists the **primary** screen (implement first) and any **alternates** worth referencing.

---

## `/` — Dashboard Overview

| Variant               | Screen ID                          | Title                                |
| --------------------- | ---------------------------------- | ------------------------------------ |
| **Desktop (primary)** | `cd57ff1caf454382b0376264b3e7c083` | Control Plane Overview (Desktop)     |
| Desktop (alt)         | `0791a102363d4e888f6376cff23cdc79` | Control Plane Dashboard Overview     |
| Desktop (alt)         | `056b84742ef44a9ab491edc8e5417d3f` | Cortex Plane: Control Plane Overview |
| **Mobile (primary)**  | `932880c8e94a4fad93e27a898ad6c8f7` | Control Plane (Mobile)               |

**Why chosen:**

- `cd57ff1c` is the most polished desktop dashboard with sidebar nav (Dashboard, Agents, Jobs, Approvals, Settings), KPI cards (Active Agents, Running Jobs, Pending Approvals, Error Rate), live activity feed with streaming log, and system health panel showing Kubernetes/Postgres/Qdrant/Workers status.
- `0791a102` is a strong alternate with a slightly different nav structure (adds Deployments, Storage) and a "Cluster Optimization" recommendation card — useful for an enhanced iteration.
- `056b8474` offers a "Compute Power" upsell card and Knowledge Base nav item — reference for future feature additions.
- `932880c8` is a clean mobile overview with stats, live activity feed, and system health accordions — a clean light-theme mobile design with bottom tab nav.

**Other overview screens (iterations, not recommended as primary):**
`05bc30c6`, `eec37d8d`, `c5ebc7ab`, `1b4e290a`, `5a547faa`, `10936592`, `46d58b2c`, `7860167853bd`, `ad7a3dfd`, `bb46d1a0`

---

## `/agents` — Agents Inventory

| Variant               | Screen ID                          | Title                          |
| --------------------- | ---------------------------------- | ------------------------------ |
| **Desktop (primary)** | `649a8b5b9b584ab9a6b667bf2b538f40` | Agents Inventory (Desktop)     |
| Desktop (alt)         | `6198c32dd5f74558bd82c39ec75146c0` | Cortex Plane: Agents Inventory |
| Desktop (alt)         | `bf89861f84d4459fb5600f680eded4fc` | Agent Inventory List           |
| **Mobile (primary)**  | `5be0ebab9d30479c98c3eb4761f7c8c9` | Agents Inventory (Mobile)      |

**Why chosen:**

- `649a8b5b` shows the best desktop agent list with top nav (Dashboard/Agents/Workflows/Logs), filter/sort controls, status badges (EXECUTING, IDLE, HALTED), resource usage (CPU/RAM), current mission descriptions, and action icons per agent. Includes pagination and fleet stats at bottom.
- `6198c32d` is an alternate desktop layout — reference for card/grid view toggle.
- `bf89861f` shows a slightly different list layout — useful for comparison.
- `5be0ebab` is the mobile agents list with filter tabs (All Agents, Active, Paused, Drafts), quick-action bottom sheet, and a clean dark theme.

**Other inventory screens (iterations):**
`9ad52772`, `f2c54d3d`

---

## `/agents/:id` — Agent Detail & Steering

| Variant               | Screen ID                          | Title                                |
| --------------------- | ---------------------------------- | ------------------------------------ |
| **Desktop (primary)** | `87d871d37d5d40b488d6b2a74f22e045` | Agent Detail & Steering (Desktop)    |
| Desktop (alt)         | `56b98646c7364c348a6ab7578d1c1341` | Cortex Plane: Agent Execution Detail |
| Desktop (alt)         | `23bd5dcc632a4bebadc439cdec4318b5` | Live Agent Execution Detail          |
| Desktop (alt)         | `1b86cb2e3e5d4482bb9dccb592b8d698` | Agent Detail & Steering (Desktop)    |
| **Mobile (primary)**  | `c0f4edfb42314369ac52e659ae2d58d5` | Agent Detail (Mobile)                |

**Why chosen:**

- `87d871d3` has the richest agent detail layout: top nav with tabs (Dashboard/Agents/Orchestration/History), execution phase stepper (Initialized → Planning → Executing → Consolidation), live output console, steer & control panel with approve/reject buttons, runtime context showing connected services, and resource metrics (CPU, memory, network, tokens/sec).
- `56b98646` shows a similar detail with a different nav structure (Clusters navigation breadcrumb), mission steering with confidence level controls, agent manifest details including model architecture and replication info, and an infrastructure location map. Good reference for the agent manifest section.
- `23bd5dcc` shows execution with a human approval gate, steering controls, and context source panel — important reference for the approval-within-execution flow.
- `1b86cb2e` is another steering variant with a slightly different layout.
- `c0f4edfb` is the mobile detail with sidebar nav (Active Agent, Memory Banks, Orchestration), live output console, resource pressure chart, and a steer input at the bottom.

**Other detail screens (iterations):**
`86a427d6`

---

## `/agents/:id/browser` — Browser Observation

| Variant               | Screen ID                          | Title                         |
| --------------------- | ---------------------------------- | ----------------------------- |
| **Desktop (primary)** | `c314f2da770d434c8ac778b1b5e6dc8b` | Browser Observation (Desktop) |

**Why chosen:**

- `c314f2da` is the only browser observation screen. Shows a live browser viewport with session tabs, URL bar, video playback of agent actions, a scrollable history panel with page screenshots (Login Page, Dashboard, Settings Modal, Profile View), a trace timeline at the bottom with event types (GET, CLICK, CONSOLE, SNAPSHOT, IDLE, POST), and connection status (Live Connection, Latency). This is feature-complete for the browser observation view.

---

## `/approvals` — Approvals Queue

| Variant               | Screen ID                          | Title                     |
| --------------------- | ---------------------------------- | ------------------------- |
| **Desktop (primary)** | `0e817d399cdf4136b5ce09aa9830e741` | Approvals Queue (Desktop) |
| Desktop (alt)         | `b1de7364e84b49c2a850a93c45d28dcf` | Approvals Queue (Desktop) |

**Why chosen:**

- `0e817d39` is a polished approvals queue with risk-level badges (CRITICAL, MEDIUM, LOW), countdown timers, tag chips (Kubernetes, Prod-US-East, AI Generated Code), audit history sidebar, and approve/reject actions per request. Nav includes Dashboard, Approvals, Agents, Audit Logs, Settings.
- `b1de7364` is a close variant with minor layout differences (REQUEST CONTEXT links, slightly different audit timeline) — good for A/B comparison during implementation.

---

## `/jobs` — Jobs History

| Variant               | Screen ID                          | Title                         |
| --------------------- | ---------------------------------- | ----------------------------- |
| **Desktop (primary)** | `403dd1467c104f529ed47d442434bc33` | Jobs History & Detailed Steps |
| **Mobile (primary)**  | `0f3db4d157b541bb873ecf1797d29d1b` | Jobs History (Mobile)         |

**Why chosen:**

- `403dd146` shows the desktop jobs list with status filters (Status, Agent, Type, Time range), search, paginated table (Job ID, Status, Agent Name, Type), and a slide-out detail panel showing execution steps with durations, error messages, metrics (CPU, Memory, Network IO, Thread Count), and recent logs. System status indicator and user avatar in sidebar.
- `0f3db4d1` is the mobile jobs history with filter chips (All, Failed, Running), job cards showing retry/logs actions, progress indicators, and duration/size metadata.

---

## `/memory` — Memory Explorer

| Variant               | Screen ID                          | Title                     |
| --------------------- | ---------------------------------- | ------------------------- |
| **Desktop (primary)** | `a3c20c7479f542c7bb63db56f4f5c165` | Memory Explorer (Desktop) |

**Why chosen:**

- `a3c20c74` is the only memory explorer screen. Shows a search-driven interface for vector embeddings with filters (Namespace, Agent, Score threshold, Time range), ranked results list with match percentages, and a detail panel showing verified source content with rich markdown rendering. Includes "New Query" CTA and CSV export. Light theme with sidebar nav (Dashboard, Agents, Memory Explorer, Settings, Logs).

---

## `/pulse` — AI Pulse Content Pipeline

| Variant               | Screen ID                          | Title                      |
| --------------------- | ---------------------------------- | -------------------------- |
| **Desktop (primary)** | `bc3b8f00daa64b40a4e68f5fd83823ff` | AI Pulse Content Pipeline  |
| **Mobile (primary)**  | `6450f82420ad4c4181c0ad890cd549a1` | AI Pulse Pipeline (Mobile) |

**Why chosen:**

- `bc3b8f00` shows a Kanban-style pipeline with columns (Draft → Review → Queued → Published), content cards with type badges (AI RESPONSE, CASE STUDY, NEWSLETTER, BLOG, DOCS), agent model tags (GPT-4 Writer, Claude Editor, DALL-E Artist), word counts, confidence scores, and publish actions. Top nav includes Dashboard, Pipeline, Agents, Settings.
- `6450f824` is the mobile pipeline view showing a tab-based layout (Ingestion, Processing, Deployment) with throughput/health stats, active agent cards with status indicators, and bottom tab nav.

---

## Summary Table

| Route                 | Desktop Screen                     | Mobile Screen                      |
| --------------------- | ---------------------------------- | ---------------------------------- |
| `/`                   | `cd57ff1caf454382b0376264b3e7c083` | `932880c8e94a4fad93e27a898ad6c8f7` |
| `/agents`             | `649a8b5b9b584ab9a6b667bf2b538f40` | `5be0ebab9d30479c98c3eb4761f7c8c9` |
| `/agents/:id`         | `87d871d37d5d40b488d6b2a74f22e045` | `c0f4edfb42314369ac52e659ae2d58d5` |
| `/agents/:id/browser` | `c314f2da770d434c8ac778b1b5e6dc8b` | —                                  |
| `/approvals`          | `0e817d399cdf4136b5ce09aa9830e741` | —                                  |
| `/jobs`               | `403dd1467c104f529ed47d442434bc33` | `0f3db4d157b541bb873ecf1797d29d1b` |
| `/memory`             | `a3c20c7479f542c7bb63db56f4f5c165` | —                                  |
| `/pulse`              | `bc3b8f00daa64b40a4e68f5fd83823ff` | `6450f82420ad4c4181c0ad890cd549a1` |
