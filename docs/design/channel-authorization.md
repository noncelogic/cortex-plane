# Channel Authorization — Design Document

**Issue:** #268
**Status:** Proposed
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-07
**Depends on:** [Agent Capability Model](./agent-capabilities.md) (#264), [Operator Dashboard](./operator-dashboard.md) (#267)

---

## 1. Problem Statement

Cortex Plane's current authorization model is static and coarse:

1. **Static allow lists.** `CHANNEL_TELEGRAM_ALLOWED_USERS` is a comma-separated env var checked inside the Telegram adapter. Discord has an equivalent `CHANNEL_DISCORD_ALLOWED_USERS`. These are platform-wide — no per-agent granularity.

2. **No identity linking.** A Telegram user and a Discord user are separate `channel_mapping` rows with no unified view of the same person across channels.

3. **No authorization model per agent.** All users authorized on a channel can talk to every agent bound to that channel. There is no concept of a private vs. public agent.

4. **No enforcement in the dispatch layer.** `message-dispatch.ts` resolves agent bindings and creates sessions without checking whether the user has access to that specific agent. Authorization is only checked at the adapter edge (env var), not at the agent level.

5. **No rate limiting per user.** The `agent_user_grant.rate_limit` and `token_budget` columns exist (migration 022) but are not enforced anywhere in the message pipeline.

### North Star

An operator deploys a personal assistant agent, generates a pairing code from the dashboard, sends it to a colleague on Telegram, the colleague messages the bot, and they are immediately connected — with per-user rate limits and cost tracking. A different customer support agent on the same platform accepts messages from anyone with no pairing required.

---

## 2. Design Principles

1. **Per-agent, not per-platform.** Authorization is scoped to individual agents. The same user may be authorized for Agent A and denied for Agent B.
2. **PostgreSQL is the source of truth.** No in-memory-only permission state. The `agent_user_grant` table is the canonical record.
3. **Deny by default.** Unless an agent is explicitly configured for open access, unauthenticated users are rejected.
4. **Fail closed.** If grant lookup errors out, the message is rejected — not silently allowed.
5. **Progressive trust.** An operator can start with open access and progressively lock down as they add users. Conversely, a locked agent can be opened later.
6. **Adapter-agnostic.** Authorization logic lives in the control plane dispatch layer, not inside individual channel adapters. Adapters pass through all messages; the dispatch layer decides.

---

## 3. Authorization Model Taxonomy

Each agent declares an `access_mode` that determines how incoming messages from unknown users are handled.

### 3.1 Access Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| `private` | Only users with an `agent_user_grant` row may interact. Unknown users receive a rejection message. | Personal assistant, internal team agent |
| `approval` | Unknown users trigger an access request (pending operator review). Messages are held until approved. | Onboarding flow, invite-only with operator gatekeeping |
| `team` | Any user who is a member of the bound channel (Slack workspace, Discord guild, Telegram group) is auto-authorized. Grant is created on first message with `origin = 'auto_team'`. | Team-scoped assistant |
| `public` | Any user may interact. Grant is created on first message with `origin = 'auto_open'`. | Customer support bot, public FAQ agent |

### 3.2 Data Model

The `access_mode` is stored in the existing `agent.channel_permissions` JSONB column:

```jsonc
// agent.channel_permissions
{
  "access_mode": "private",         // "private" | "approval" | "team" | "public"
  "rejection_message": "This agent is private. Ask an operator for a pairing code.",
  "pending_message": "Your request has been submitted. You'll be notified when approved.",
  "rate_limit_default": {           // default per-user rate limit (overridable per grant)
    "max_messages": 60,
    "window_seconds": 3600
  },
  "token_budget_default": {         // default per-user token budget
    "max_tokens": 100000,
    "window_seconds": 86400
  }
}
```

**Key decision:** No migration is needed for `access_mode`. It lives in the existing JSONB column. Agents with no `access_mode` set default to `private` (deny by default).

### 3.3 Grant Origin Mapping

| Access mode | Origin value | Created by |
|-------------|-------------|------------|
| `private` | `pairing_code` or `dashboard_invite` | Operator (manual) |
| `approval` | `approval` | AccessRequestService.approve() |
| `team` | `auto_team` | Dispatch layer (auto on first message) |
| `public` | `auto_open` | Dispatch layer (auto on first message) |

All origins are already defined in the `grant_origin` enum (migration 022).

---

## 4. Identity Linking

### 4.1 Current Model

```
user_account                channel_mapping
┌──────────┐               ┌──────────────────────┐
│ id (UUID)│──1:N──────────│ user_account_id       │
│ display  │               │ channel_type          │
│ name     │               │ channel_user_id       │
└──────────┘               │ metadata (JSONB)      │
                           └──────────────────────┘
```

A `user_account` already supports multiple `channel_mapping` rows — one per (channel_type, channel_user_id) pair. A user who authenticates via the dashboard (GitHub OAuth) gets a `user_account`. When they pair on Telegram, a `channel_mapping` row links Telegram user ID → same `user_account`.

### 4.2 Linking Flows

**Dashboard-first (recommended):**

```
1. User logs into dashboard via GitHub OAuth → user_account created
2. User navigates to Settings → Linked Accounts
3. Clicks "Link Telegram" → shown instructions to message bot with /link command
4. Bot replies with a one-time code
5. User enters code on dashboard → channel_mapping row created
```

**Channel-first (pairing code):**

```
1. Operator generates pairing code on dashboard for Agent A
2. Shares code with colleague via DM / email
3. Colleague messages bot: "/pair ABC123"
4. PairingService.redeem() → creates agent_user_grant + channel_mapping
5. If user has no user_account yet, an anonymous user_account is created
   (display_name from Telegram/Discord profile)
```

**Channel-first (approval queue):**

```
1. Unknown user messages Agent B (access_mode = "approval")
2. Dispatch creates anonymous user_account + channel_mapping
3. AccessRequestService.create() → pending access_request
4. Operator sees notification on dashboard → approves
5. Agent_user_grant created with origin = "approval"
```

### 4.3 Anonymous Users

When a user messages from a channel without any existing `channel_mapping`, the dispatch layer auto-creates:

1. A new `user_account` with `display_name` from the channel profile (e.g., Telegram `first_name + last_name`).
2. A `channel_mapping` linking the channel identity to that `user_account`.

This anonymous account can later be claimed when the user authenticates via the dashboard and links their channel identity.

**Account merge:** If a user authenticates on the dashboard and links a channel identity that already has an anonymous `user_account`, the system merges: reassign all `channel_mapping`, `agent_user_grant`, and `session` rows from the anonymous account to the authenticated account, then soft-delete the anonymous account.

---

## 5. Authorization Enforcement

### 5.1 Enforcement Point

Authorization is enforced in `message-dispatch.ts`, after agent resolution and before session creation. The current flow is:

```
RoutedMessage → resolve agent → create session → create job
```

The new flow inserts an authorization check:

```
RoutedMessage → resolve agent → CHECK AUTHORIZATION → create session → create job
```

### 5.2 Authorization Check Logic

```typescript
async function checkAuthorization(
  db: Kysely<Database>,
  agentId: string,
  userAccountId: string,
  channelMappingId: string,
  accessMode: AccessMode,
  messagePreview?: string,
): Promise<AuthzResult>
```

| `accessMode` | Logic |
|-------------|-------|
| `private` | Look up `agent_user_grant` for (agent_id, user_account_id) where `revoked_at IS NULL`. If found and not expired → `ALLOWED`. Otherwise → `DENIED` with rejection message. |
| `approval` | Same grant lookup. If found → `ALLOWED`. If not found, call `AccessRequestService.create()` → `PENDING` with pending message. |
| `team` | Check if user is a member of the bound channel (via `agent_channel_binding`). If yes, upsert `agent_user_grant` with `origin = 'auto_team'` → `ALLOWED`. If membership check fails → `DENIED`. |
| `public` | Upsert `agent_user_grant` with `origin = 'auto_open'` → `ALLOWED`. |

Return type:

```typescript
type AuthzResult =
  | { status: "allowed"; grantId: string }
  | { status: "denied"; message: string }
  | { status: "pending"; message: string; requestId: string }
```

### 5.3 Team Membership Check

For `team` mode, membership is determined by the channel platform:

- **Telegram group:** The message itself proves membership (only group members can send messages to a group chat). If the `agent_channel_binding.chat_id` matches the message's `chatId` (group), auto-grant.
- **Discord guild:** The message includes `guildId`. If the agent is bound to a channel in that guild, auto-grant.
- **Slack workspace:** The message includes `teamId`. If the agent is bound to a channel in that workspace, auto-grant.

No external API calls needed — channel membership is implicit in the message itself.

### 5.4 Adapter Simplification

Once dispatch-layer authorization is in place, the adapter-level env vars (`CHANNEL_TELEGRAM_ALLOWED_USERS`, `CHANNEL_DISCORD_ALLOWED_USERS`) become **redundant**. They will be:

1. Deprecated in config documentation.
2. Kept functional as a backwards-compatible "emergency kill switch" (adapter rejects before dispatch).
3. Logged with a deprecation warning at startup if set.

---

## 6. Rate Limiting & Token Budgets

### 6.1 Per-User Rate Limiting

Rate limits are stored in `agent_user_grant.rate_limit` JSONB:

```jsonc
{
  "max_messages": 60,       // messages allowed per window
  "window_seconds": 3600    // sliding window duration
}
```

**Enforcement:** In `message-dispatch.ts`, after authorization passes, count recent `session_message` rows for (agent_id, user_account_id) within the window. If over limit, respond with a rate-limit message and skip job creation.

```sql
SELECT count(*) FROM session_message sm
  JOIN session s ON s.id = sm.session_id
  WHERE s.agent_id = $1
    AND s.user_account_id = $2
    AND sm.role = 'user'
    AND sm.created_at > now() - interval '1 second' * $3
```

**Default cascade:** If the grant has no `rate_limit`, fall back to `agent.channel_permissions.rate_limit_default`. If that is also absent, no rate limit.

### 6.2 Per-User Token Budgets

Token budgets are stored in `agent_user_grant.token_budget` JSONB:

```jsonc
{
  "max_tokens": 100000,    // max tokens per window
  "window_seconds": 86400  // sliding window
}
```

**Enforcement:** Query `job_cost_tracking` (migration 020) for completed jobs within the window, sum `total_tokens`. If over budget, respond with a budget-exceeded message.

```sql
SELECT coalesce(sum(total_tokens), 0) FROM job_cost_tracking jct
  JOIN job j ON j.id = jct.job_id
  WHERE j.agent_id = $1
    AND j.session_id IN (
      SELECT id FROM session WHERE user_account_id = $2
    )
    AND jct.created_at > now() - interval '1 second' * $3
```

### 6.3 Ban / Block Mechanism

Revoking a grant is the ban mechanism. Set `agent_user_grant.revoked_at = now()` via the dashboard or API. The user's messages will be rejected on the next dispatch.

For platform-wide bans (not just per-agent), add a `user_account.banned_at` column (future migration). Dispatch checks this first, before per-agent grants.

---

## 7. Pairing Flow (All Variants)

### 7.1 Operator-Initiated Pairing Code (implemented)

Already implemented in `PairingService` (migration 022, `src/auth/pairing-service.ts`).

```
Operator                              Dashboard                          Bot
   │                                      │                                │
   ├─ Agent → Users → Generate Code ──────┤                                │
   │                                      ├─ PairingService.generate() ────┤
   │                                      ├─ Shows code: "ABC123"          │
   ├─ Shares code with user ──────────────┤                                │
   │                                      │                                │
User                                      │                                │
   ├─ Sends "/pair ABC123" to bot ────────┼────────────────────────────────┤
   │                                      │  PairingService.redeem() ──────┤
   │                                      │  → creates agent_user_grant    │
   │                                      │  → bot replies "Welcome!"     │
```

### 7.2 Approval Queue (implemented)

Already implemented in `AccessRequestService` (migration 023, `src/auth/access-request-service.ts`).

```
Unknown User                          Bot                               Dashboard
   │                                    │                                    │
   ├─ Sends message to agent ───────────┤                                    │
   │                                    ├─ Dispatch: access_mode=approval    │
   │                                    ├─ AccessRequestService.create() ────┤
   │                                    ├─ Replies "Pending approval"        │
   │                                    │                                    │
Operator                                │                                    │
   │                                    │                                    │
   ├────────────────────────────────────┼─ Sees pending request notification ┤
   ├────────────────────────────────────┼─ Clicks "Approve" ─────────────────┤
   │                                    │  AccessRequestService.approve() ───┤
   │                                    │  → creates agent_user_grant        │
   │                                    ├─ Notifies user "You're approved!"  │
```

### 7.3 Dashboard Invite (new — ticket needed)

Operator creates a grant directly from the dashboard by selecting a known user.

```
POST /api/agents/:agentId/grants
{
  "user_account_id": "uuid-of-user",
  "access_level": "write",
  "rate_limit": { "max_messages": 60, "window_seconds": 3600 }
}
```

Creates `agent_user_grant` with `origin = 'dashboard_invite'`, `granted_by` = operator's user ID.

### 7.4 QR Code (future)

Pairing code wrapped in a QR code. The dashboard renders a QR that encodes a deep link:

- Telegram: `https://t.me/<bot_username>?start=pair_ABC123`
- Discord: Link to a channel with instructions
- Web: URL to a pairing page

This is a dashboard UX enhancement over §7.1, not a new backend flow. The `PairingService` backend is unchanged.

---

## 8. Per-Agent User Management API

### 8.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/:id/grants` | List active grants for an agent |
| `POST` | `/api/agents/:id/grants` | Create a dashboard invite grant |
| `DELETE` | `/api/agents/:id/grants/:grantId` | Revoke a grant |
| `PATCH` | `/api/agents/:id/grants/:grantId` | Update rate limit / token budget / access level |
| `GET` | `/api/agents/:id/access-requests` | List pending access requests |
| `POST` | `/api/agents/:id/access-requests/:requestId/approve` | Approve a request |
| `POST` | `/api/agents/:id/access-requests/:requestId/deny` | Deny a request |
| `POST` | `/api/agents/:id/pairing-codes` | Generate a pairing code |
| `GET` | `/api/agents/:id/pairing-codes` | List active pairing codes |
| `DELETE` | `/api/agents/:id/pairing-codes/:codeId` | Revoke a pairing code |

### 8.2 Grant List Response

```jsonc
{
  "grants": [
    {
      "id": "uuid",
      "user": {
        "id": "uuid",
        "display_name": "Alice",
        "channels": [
          { "type": "telegram", "user_id": "123456", "display": "@alice_tg" },
          { "type": "discord", "user_id": "789012", "display": "Alice#1234" }
        ]
      },
      "access_level": "write",
      "origin": "pairing_code",
      "rate_limit": { "max_messages": 60, "window_seconds": 3600 },
      "token_budget": { "max_tokens": 100000, "window_seconds": 86400 },
      "granted_by": "uuid",
      "created_at": "2026-03-07T12:00:00Z",
      "expires_at": null
    }
  ],
  "total": 1
}
```

---

## 9. Dashboard UX

### 9.1 Agent Detail → Users Tab

Added to the agent detail page as a new tab alongside existing tabs:

```
[Overview] [Jobs] [Users] [Settings]
```

**Users tab contents:**

1. **Access mode selector** — dropdown: Private / Approval / Team / Public. Changing this updates `agent.channel_permissions.access_mode`.

2. **User list** — table of active grants with columns:
   - User (display name + linked channel identities)
   - Access level (read / write)
   - Origin (badge: pairing code / invite / approval / auto)
   - Rate limit (messages/window)
   - Token usage (used / budget)
   - Actions (edit, revoke)

3. **Actions:**
   - "Generate Pairing Code" button → modal with code + QR + copy button
   - "Invite User" button → user search → create dashboard_invite grant
   - "Bulk Revoke" → multi-select + confirm

### 9.2 Pending Approval Queue

Shown as a notification badge on the Agent card (agent list page) and as a sub-section on the Users tab:

```
┌─────────────────────────────────────────────────────┐
│ Pending Requests (3)                                │
├─────────────────────────────────────────────────────┤
│ @telegram_user_42  •  "Hey, can I use this bot?"    │
│                              [Approve] [Deny]       │
│ @discord_user_99   •  "Hello"                       │
│                              [Approve] [Deny]       │
└─────────────────────────────────────────────────────┘
```

### 9.3 User Profile Page (future)

Linked from the grant list. Shows:

- All linked channel identities
- All agent grants (which agents this user has access to)
- Usage statistics (messages sent, tokens consumed, cost accrued)
- Session history

---

## 10. Implementation Tickets

### T1: Authorization check in message dispatch (#333-T1)

**Scope:** `packages/control-plane/src/channels/message-dispatch.ts`, new `src/channels/authorization.ts`

**Work:**
- Extract `checkAuthorization()` function in `authorization.ts`
- Read `access_mode` from `agent.channel_permissions` (default: `private`)
- Implement grant lookup, auto-grant for team/public, access-request creation for approval
- Wire into `createMessageDispatch()` between agent resolution and session creation
- Handle `DENIED` and `PENDING` responses (reply to user, skip job creation)

**Acceptance criteria:**
- Private agent rejects unknown users with configurable message
- Public agent auto-creates grant on first message
- Approval agent creates access request on first message
- Team agent auto-grants for same-channel members
- Agent with no `access_mode` defaults to `private`

**Dependencies:** None (uses existing tables)
**Size:** M

### T2: Per-user rate limiting enforcement (#333-T2)

**Scope:** `packages/control-plane/src/channels/message-dispatch.ts`, new `src/channels/rate-limiter.ts`

**Work:**
- `checkRateLimit(db, agentId, userAccountId, grant)` — query `session_message` count
- Cascade: `grant.rate_limit` → `agent.channel_permissions.rate_limit_default` → no limit
- Reply with rate-limit message if exceeded
- Wire into dispatch after authorization, before session lookup

**Acceptance criteria:**
- User exceeding message rate limit gets informative reply
- Rate limit from grant overrides agent default
- No rate limit if neither grant nor agent specifies one
- Test: 5 messages in 10-second window with limit of 3 → messages 4-5 rejected

**Dependencies:** T1
**Size:** S

### T3: Per-user token budget enforcement (#333-T3)

**Scope:** `packages/control-plane/src/channels/message-dispatch.ts`, `src/channels/rate-limiter.ts`

**Work:**
- `checkTokenBudget(db, agentId, userAccountId, grant)` — query `job_cost_tracking`
- Same cascade pattern as rate limiting
- Reply with budget-exceeded message if over limit

**Acceptance criteria:**
- User exceeding token budget gets informative reply
- Budget from grant overrides agent default
- Test: user with 1000-token budget, after consuming 1001 tokens → next message rejected

**Dependencies:** T1, job_cost_tracking (migration 020)
**Size:** S

### T4: Adapter simplification — remove env var allow lists (#333-T4)

**Scope:** `packages/adapter-telegram/src/adapter.ts`, `packages/adapter-discord/src/adapter.ts`, config

**Work:**
- Remove `CHANNEL_TELEGRAM_ALLOWED_USERS` filtering from Telegram adapter
- Remove `CHANNEL_DISCORD_ALLOWED_USERS` filtering from Discord adapter
- Log deprecation warning at startup if env vars are still set
- All authorization moves to dispatch layer (T1)

**Acceptance criteria:**
- Adapters pass through all messages without filtering
- Setting deprecated env vars logs a warning but does not break
- All authorization tests pass without env vars

**Dependencies:** T1
**Size:** S

### T5: Agent user management API routes (#333-T5)

**Scope:** `packages/control-plane/src/routes/agents.ts` (extend existing file)

**Work:**
- `GET /api/agents/:id/grants` — list active grants with user + channel info
- `POST /api/agents/:id/grants` — create dashboard_invite grant
- `DELETE /api/agents/:id/grants/:grantId` — revoke (set `revoked_at`)
- `PATCH /api/agents/:id/grants/:grantId` — update rate_limit, token_budget, access_level
- Wire PairingService and AccessRequestService endpoints under agent routes

**Acceptance criteria:**
- All CRUD operations work with proper validation
- Grant list includes joined user + channel_mapping data
- Revoking a grant prevents future messages (verified via T1 logic)
- API matches §8 contracts

**Dependencies:** T1
**Size:** M

### T6: Auto-create anonymous user accounts in dispatch (#333-T6)

**Scope:** `packages/control-plane/src/channels/message-dispatch.ts`, `src/channels/user-resolver.ts`

**Work:**
- When a `RoutedMessage` arrives with an unknown channel identity, create:
  1. `user_account` with `display_name` from channel profile
  2. `channel_mapping` linking channel_user_id → new user_account
- Return `userAccountId` for downstream authorization and session logic
- Handle race conditions (concurrent messages from same unknown user)

**Acceptance criteria:**
- First message from unknown Telegram user creates user_account + channel_mapping
- Second message from same user reuses existing records (idempotent)
- Display name is populated from channel profile metadata

**Dependencies:** None
**Size:** S

### T7: Account merge on dashboard authentication (#333-T7)

**Scope:** New `src/auth/account-merge-service.ts`

**Work:**
- When a dashboard-authenticated user links a channel identity that belongs to an anonymous account:
  1. Reassign `channel_mapping` rows to authenticated account
  2. Reassign `agent_user_grant` rows
  3. Reassign `session` rows
  4. Reassign `access_request` rows
  5. Soft-delete anonymous `user_account`
- Wrap in a transaction
- Audit log the merge

**Acceptance criteria:**
- Merging anonymous + authenticated account preserves all grants and sessions
- Post-merge, the anonymous account is no longer usable
- Concurrent merge attempts are serialized (no duplicate grants)

**Dependencies:** T6
**Size:** M

### T8: Dashboard — Users tab on agent detail (#333-T8)

**Scope:** Dashboard frontend (React)

**Work:**
- Add "Users" tab to agent detail page
- Access mode selector (dropdown)
- Grant list table with user info, origin badge, rate limits, usage
- Generate pairing code modal (with copy + QR)
- Invite user modal (user search)
- Approve / deny access request inline actions
- Revoke grant with confirmation

**Acceptance criteria:**
- Operator can view and manage all users for an agent
- Pairing code generation and display works
- Access requests show with approve/deny actions
- Changing access mode updates immediately

**Dependencies:** T5
**Size:** L

---

## 11. Migration Plan

### Already landed

| Migration | Content | Ticket |
|-----------|---------|--------|
| 003 | `user_account`, `channel_mapping` | — |
| 012 | `agent_channel_binding` | — |
| 020 | `job_cost_tracking` | #266 |
| 022 | `pairing_code`, `agent_user_grant`, grant enums | #336 |
| 023 | `access_request` | #337 |

### No new migrations required

The `access_mode` configuration lives in the existing `agent.channel_permissions` JSONB column. Rate limits and token budgets use the existing `agent_user_grant` columns. No schema changes are needed for the core authorization work.

### Future migration (if needed)

If platform-wide bans are required (§6.3), add:

```sql
-- 0XX: Add banned_at to user_account
ALTER TABLE user_account ADD COLUMN banned_at TIMESTAMPTZ;
CREATE INDEX idx_user_account_banned ON user_account (id) WHERE banned_at IS NOT NULL;
```

---

## 12. Security Considerations

1. **Pairing codes are short-lived.** Default TTL is 1 hour. Codes are single-use and cannot be replayed.

2. **Grant revocation is immediate.** Setting `revoked_at` takes effect on the next message dispatch. No cache to invalidate.

3. **Access requests expose minimal data.** The `message_preview` stored in `access_request` is limited to the first message and is visible only to the agent's operator.

4. **Auto-grants for public agents are rate-limited.** Even with `access_mode = 'public'`, per-user rate limits and token budgets apply. This prevents abuse from anonymous users.

5. **Account merge is transactional.** The merge operation runs in a single database transaction to prevent partial state.

6. **Channel membership is validated by the platform.** For `team` mode, membership is proven by the fact that the message was delivered by the platform's API (e.g., only Telegram group members can send messages to a group chat).

---

## 13. Open Questions

1. **Multi-agent pairing codes.** Should a pairing code grant access to multiple agents at once? Current design is single-agent per code. A "workspace invite" concept could wrap multiple codes.

2. **Grant expiry notifications.** Should users be notified before their grant expires? This adds notification infrastructure but improves UX for time-limited access.

3. **Read-only access semantics.** The `access_level = 'read'` grant exists in the schema. What does "read" mean for a chat agent? Receive responses but not send messages? This needs product definition before implementation.

4. **Cross-channel grant portability.** If a user is granted access on Telegram, does that grant apply when they message from Discord (same `user_account`, different `channel_mapping`)? Current design: yes — grants are per `user_account`, not per `channel_mapping`.
