# Full-Stack Gap Audit — Cortex Plane

> **Issue**: #534
> **Date**: 2026-03-09
> **Scope**: Control-plane routes, services, dashboard UI, cross-cutting concerns

---

## Executive Summary

Audited **~130 API routes** across 23 route files, **all service classes**, **19 dashboard pages** (84 API methods), and cross-cutting concerns (auth, lifecycle, chat, credentials). The codebase is ~95% wired and functional. Key gaps center on **stub endpoints** (content pipeline, memory sync), **dead service methods**, **unused DB columns**, and **a handful of phantom UI features**.

---

## 1. Broken

Features that exist but do not work correctly.

### 1.1 Agent Pause/Resume — Stub Returning 202

- **Routes**: `POST /agents/:agentId/pause`, `POST /agents/:agentId/resume`
- **File**: `src/routes/agents.ts`
- **Behavior**: Returns `202 Accepted` with `{ status: "pausing" }` / `{ status: "resuming" }` but performs **no actual work**. The lifecycle manager has real `pause()` / `resume()` methods that are never called from these routes.
- **Impact**: Dashboard buttons exist, user gets success feedback, nothing happens.
- **Severity**: HIGH
- **Fix**: Wire route handlers to `lifecycleManager.pause()` / `lifecycleManager.resume()`, or remove the routes and UI buttons.

### 1.2 Browser Screenshot/Event History Always Empty

- **Routes**: `GET /agents/:agentId/browser/screenshots`, `GET /agents/:agentId/browser/events`
- **File**: `src/routes/dashboard.ts`
- **Behavior**: Always returns `[]`. No persistence layer for screenshots or browser events exists.
- **Dashboard**: `/agents/[agentId]/browser` — screenshot gallery and event timeline are fully built but always empty. No error shown.
- **Severity**: MEDIUM
- **Fix**: Implement persistence for captured screenshots and browser events, or show "no history available" UI state.

### 1.3 Session Cleanup Startup — Silent Swallow

- **File**: `src/app.ts:181`
- **Behavior**: `sessionService.cleanupExpired().catch(() => { /* Non-critical, log and continue */ })` — comment says "log" but no log statement present.
- **Severity**: LOW
- **Fix**: Add `app.log.warn(err, "session cleanup failed")` in the catch block.

### 1.4 Chat Job Error Detail Swallowed

- **File**: `src/routes/chat.ts:491`
- **Behavior**: When fetching full error details for a failed chat job, the `.catch()` resolves with empty error. User sees "failed" status without the actual error message.
- **Severity**: MEDIUM
- **Fix**: Propagate the error column value or log the fetch failure.

---

## 2. Missing UI — Backend Works, No Dashboard Surface

### 2.1 Force Logout All Sessions

- **Service**: `SessionService.deleteUserSessions(userId)`
- **File**: `src/auth/session-service.ts`
- **Status**: Fully implemented, never called from any route or UI.
- **Severity**: MEDIUM (security feature)
- **Suggested endpoint**: `POST /auth/logout-all`

### 2.2 List Pending Access Requests (Service Method)

- **Service**: `AccessRequestService.listPending(agentId)`
- **File**: `src/auth/access-request-service.ts`
- **Status**: Implemented, never called. The route `GET /agents/:agentId/access-requests` exists but uses a different query path.
- **Severity**: LOW

### 2.3 Per-Job Pending Approval Count

- **Service**: `ApprovalService.getPendingForJob(jobId)`
- **File**: `src/approval/service.ts`
- **Status**: Implemented, never called.
- **Severity**: LOW
- **Use case**: Show blocking approvals on job detail view.

### 2.4 Model Selection Per Agent

- **Backend**: `agent.model_config` JSONB column exists; `modelsForProvider()` resolves available models.
- **Dashboard**: Models shown as read-only tags on provider cards. No edit UI to select model per agent.
- **Severity**: MEDIUM
- **Fix**: Add model selector to agent creation/edit form.

---

## 3. Missing Backend — UI Exists, Backend Not Implemented

### 3.1 Content Pipeline (Pulse Page)

- **Dashboard page**: `/pulse` — full Kanban board (DRAFT → IN_REVIEW → QUEUED → PUBLISHED), detail drawer, publish dialog, archive confirmation.
- **Routes**:
  - `GET /content` → returns `{ items: [] }` (always empty)
  - `POST /content/:id/publish` → returns `501 Not Implemented`
  - `POST /content/:id/archive` → returns `501 Not Implemented`
- **File**: `src/routes/dashboard.ts`
- **Severity**: HIGH (full UI built, zero backend)
- **Fix**: Implement content CRUD service + DB table, or remove `/pulse` page.

### 3.2 Memory Sync

- **Dashboard**: `/memory` page has "Sync" button.
- **Route**: `POST /memory/sync` → returns `501 Not Implemented`
- **File**: `src/routes/dashboard.ts`
- **Severity**: MEDIUM (search works, sync doesn't)
- **Fix**: Implement memory synchronization logic or remove button.

### 3.3 Agent Memory Page

- **Dashboard**: `/agents/[agentId]/memory` — shows `RouteNotImplemented` placeholder.
- **Backend**: `GET /memory/search` exists and works, but no per-agent memory API.
- **Severity**: MEDIUM
- **Fix**: Wire page to existing memory search filtered by agentId.

---

## 4. Partial — Wired But Incomplete

### 4.1 Grant Access Level Not Enforced

- **DB columns**: `agent_user_grant.access_level` (read/write)
- **Route**: `POST /agents/:agentId/users` accepts `access_level` parameter, stores it.
- **Problem**: Authorization logic in `channel-auth-guard.ts` performs binary allow/deny check only — `access_level` is **never read**.
- **Files**: `src/auth/channel-auth-guard.ts`, `src/routes/agent-user-routes.ts`
- **Severity**: MEDIUM
- **Fix**: Enforce access_level in channel auth guard (read-only users can't send messages).

### 4.2 Token Budget / Rate Limit on Grants Not Enforced

- **DB columns**: `agent_user_grant.token_budget`, `agent_user_grant.rate_limit`
- **Route**: `PATCH /agents/:agentId/users/:grantId` accepts and stores these values.
- **Problem**: No code reads these columns. `user-rate-limiter.ts` operates at job level, not grant level.
- **Severity**: MEDIUM
- **Fix**: Wire grant-level rate limiting into chat/job creation flow.

### 4.3 Approval Notification Flow Incomplete

- **Methods**: `ApprovalService.recordNotification()`, `ApprovalService.shouldNotify()`
- **File**: `src/approval/service.ts`
- **Status**: Methods exist but are never called. Notification tracking was designed but not completed.
- **Severity**: LOW
- **Fix**: Complete notification integration or remove stubs.

### 4.4 Approval Resumption Flow Incomplete

- **Method**: `ApprovalService.resumeApproval()`
- **File**: `src/approval/service.ts`
- **Status**: Implemented but never called from agent-execute or any route.
- **Severity**: LOW

### 4.5 Capability Audit Log Table Never Populated

- **DB table**: `capability_audit_log` (created in migration 018)
- **Status**: Table exists in schema. **No INSERT statements found anywhere in codebase.**
- **Route**: `GET /agents/:agentId/capability-audit` queries it (always returns empty).
- **Severity**: MEDIUM
- **Fix**: Emit audit events on tool binding changes, or remove table + route.

### 4.6 ~~Agent Config Column Unused~~ effective_capabilities Column Unused

- **DB column**: `agent.effective_capabilities` (JSONB) — added in migration 018 but never read or written by application code.
- **Status**: **RESOLVED** — column dropped in migration 034 (#557). Note: original audit incorrectly identified `agent.config` as unused; `config` is actively read for webhook tool definitions.
- **Severity**: LOW

### 4.7 Effective Tools Placeholder

- **Route**: `GET /agents/:agentId/effective-tools`
- **File**: `src/routes/agent-tool-bindings.ts`
- **Status**: Returns enabled bindings only. Comment references `CapabilityAssembler integration (#302)` as future work.
- **Severity**: LOW

---

## 5. Dead Code — Unreachable or Unused

### 5.1 Unused Service Methods

| Service              | Method                 | File                                    |
| -------------------- | ---------------------- | --------------------------------------- |
| SessionService       | `deleteUserSessions()` | `src/auth/session-service.ts`           |
| AccessRequestService | `listPending()`        | `src/auth/access-request-service.ts`    |
| AgentChannelService  | `unbindChannel()`      | `src/channels/agent-channel-service.ts` |
| ApprovalService      | `resumeApproval()`     | `src/approval/service.ts`               |
| ApprovalService      | `recordExecution()`    | `src/approval/service.ts`               |
| ApprovalService      | `recordNotification()` | `src/approval/service.ts`               |
| ApprovalService      | `shouldNotify()`       | `src/approval/service.ts`               |
| ApprovalService      | `getPendingForJob()`   | `src/approval/service.ts`               |

### 5.2 Unused DB Columns

| Table              | Column         | Notes                     |
| ------------------ | -------------- | ------------------------- |
| `agent_user_grant` | `access_level` | Stored but never enforced |
| `agent_user_grant` | `token_budget` | Stored but never read     |
| `agent_user_grant` | `rate_limit`   | Stored but never read     |
| `agent`            | `config`       | Written but never read    |

### 5.3 Empty DB Table

| Table                  | Notes                                              |
| ---------------------- | -------------------------------------------------- |
| `capability_audit_log` | Created in migration 018, zero inserts in codebase |

---

## 6. Additional Findings

### 6.1 No Auth on Feedback Routes

- **Routes**: All `/api/feedback/*` endpoints have **no authentication**.
- **File**: `src/routes/feedback.ts`
- **Severity**: MEDIUM
- **Fix**: Add `requireAuth` middleware.

### 6.2 No Auth on Several Read Routes

- **Routes**: `GET /agents`, `GET /agents/:id`, `GET /agents/:id/jobs`, `GET /mcp-servers`, `GET /mcp-servers/:id`, `GET /dashboard/*`, `GET /memory/search`
- **Status**: Intentional for internal-network deployment, but should be documented or made configurable.
- **Severity**: LOW (deployment-dependent)

### 6.3 K8s Cleanup Silent Catches

- **Files**: `src/k8s/agent-deployer.ts`, `src/mcp/k8s-deployer.ts`
- **Pattern**: `.catch(() => {})` on pod/service/SA deletion (4+ instances)
- **Severity**: LOW (intentional — resources may already be gone)
- **Fix**: Add debug-level logging.

### 6.4 Checkpoint CRC Mismatch Not Audit-Logged

- **File**: `src/routes/agent-checkpoints.ts`
- **Behavior**: CRC32 verification failure returns 409 but doesn't write to `capability_audit_log`.
- **Severity**: LOW

### 6.5 Tool Name Regex Not Validated on Rotate

- **Route**: `PUT /credentials/:id/rotate` does not validate `toolName` regex.
- **Route**: `POST /credentials/tool-secret` does validate (`^[a-z0-9][a-z0-9-]{0,63}$`).
- **Severity**: LOW

---

## Follow-Up Ticket Summary

| #   | Title                                                 | Category        | Priority | Size |
| --- | ----------------------------------------------------- | --------------- | -------- | ---- |
| 1   | Wire pause/resume routes to lifecycle manager         | Broken          | P1       | S    |
| 2   | Implement content pipeline backend (Pulse)            | Missing Backend | P2       | L    |
| 3   | Persist browser screenshots/events history            | Broken          | P2       | M    |
| 4   | Enforce grant access_level in channel auth guard      | Partial         | P2       | S    |
| 5   | Enforce token_budget / rate_limit on grants           | Partial         | P2       | M    |
| 6   | Populate capability_audit_log on tool binding changes | Partial         | P2       | S    |
| 7   | Wire agent memory page to memory search API           | Missing UI      | P2       | S    |
| 8   | Implement memory sync endpoint                        | Missing Backend | P3       | M    |
| 9   | Add model selection UI per agent                      | Missing UI      | P3       | S    |
| 10  | Add force-logout-all endpoint                         | Missing UI      | P3       | S    |
| 11  | Add auth to feedback routes                           | Broken          | P2       | S    |
| 12  | Complete or remove approval notification stubs        | Dead Code       | P3       | S    |
| 13  | Clean up unused service methods                       | Dead Code       | P3       | S    |
| 14  | Fix chat job error detail swallowed                   | Broken          | P2       | S    |
| 15  | Add logging to silent K8s cleanup catches             | Partial         | P3       | S    |
| 16  | Fix session cleanup startup silent catch              | Broken          | P3       | XS   |
| 17  | Remove or use agent.config column                     | Dead Code       | P3       | XS   |
| 18  | Validate tool name regex on credential rotate         | Partial         | P3       | XS   |

---

_Generated by spike #534 — full-stack gap audit_
