# Credential Taxonomy — Design Document

**Issue:** #263
**Status:** Complete
**Authors:** Joe Graham, Hessian
**Date:** 2026-03-02

---

## 1. Problem Statement

OpenClaw conflates three fundamentally different credential types under a single concept:

- `auth-profiles.json` handles LLM providers
- Per-skill config files handle user service OAuth (e.g., Google Calendar)
- Env vars handle tool API keys (e.g., Brave Search)

There is no isolation between types, no visibility into which agent uses which credential, no rotation policy, and no multi-tenant credential resolution.

Cortex Plane replaces this with a unified credential system that:

1. Classifies credentials by purpose (LLM provider, user service, tool secret)
2. Encrypts all sensitive values at rest with per-user keys
3. Binds credentials to agents explicitly
4. Injects credentials into the execution pipeline transparently
5. Provides audit trails for compliance

---

## 2. Credential Types

### 2.1 LLM Provider Credentials (`llm_provider`)

OAuth tokens or API keys for model providers used by the agent execution backend.

| Provider | Auth | Example |
|----------|------|---------|
| `google-antigravity` | OAuth | Claude/Gemini via Google Cloud proxy |
| `openai-codex` | OAuth | GPT models via ChatGPT subscription |
| `anthropic` | OAuth | Claude via Anthropic OAuth |
| `openai` | API key | GPT models via direct API key |
| `google-ai-studio` | API key | Gemini via Google AI Studio |

**Binding:** Agent → LLM credential. Resolved per-job: the job's `userId` determines which user's credential is used, with fallback to env var `LLM_API_KEY` for backward compatibility.

### 2.2 User Service Credentials (`user_service`)

OAuth tokens for the **user's own** services. MCP tools and built-in tools act on behalf of the user.

| Provider | Auth | Scopes (examples) |
|----------|------|--------------------|
| `google-workspace` | OAuth | `calendar.readonly`, `gmail.send`, `drive.readonly` |
| `github-user` | OAuth | `repo`, `read:org`, `read:user` |
| `slack-user` | OAuth | `channels:read`, `chat:write`, `users:read` |

**Critical distinction:** `google-antigravity` (LLM provider, scope `generativelanguage`) and `google-workspace` (user service, scope `calendar.readonly`) use different OAuth clients, different scopes, and different credential classes — even though both are "Google." They coexist for the same user.

**Binding:** Agent → user service credential. Resolved per-job by `userId`. User A's Google Calendar token is never visible to User B's agent.

### 2.3 Tool Secrets (`tool_specific`)

API keys for third-party services that tools need. Not user-specific — shared across agents.

| Provider | Example |
|----------|---------|
| `brave` | Brave Search API key |

**Binding:** Admin creates the secret once. Any agent with a binding can use it. Admin role required for creation and binding.

---

## 3. Storage Model

### 3.1 Decision: Single Table with Type Discriminator

All three credential types share the `provider_credential` table with a `credential_class` enum column. Rationale:

- Encryption, audit, and lifecycle logic is identical across types.
- One `CredentialService` handles all three — no redundant codepaths.
- `agent_credential_binding` works uniformly regardless of type.
- Adding a new type requires only a new enum value, not a new table.

### 3.2 Schema: `provider_credential`

```sql
-- Migration 009 (base) + Migration 016 (taxonomy) + Migration 017 (user_service)
CREATE TABLE provider_credential (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id   UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  credential_type   TEXT NOT NULL,            -- 'oauth' | 'api_key'
  -- Encrypted fields (AES-256-GCM, per-user key)
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  api_key_enc       TEXT,
  -- Plaintext metadata
  token_expires_at  TIMESTAMPTZ,
  scopes            TEXT[],
  account_id        TEXT,
  display_label     TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  last_used_at      TIMESTAMPTZ,
  last_refresh_at   TIMESTAMPTZ,
  error_count       INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  -- Taxonomy columns (migration 016)
  credential_class  credential_class NOT NULL DEFAULT 'llm_provider',
  tool_name         VARCHAR(255),
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_account_id, provider, display_label)
);
```

**Enum values:**

```sql
CREATE TYPE credential_class AS ENUM (
  'llm_provider',     -- LLM provider API keys and OAuth tokens
  'mcp_server',       -- MCP server authentication credentials
  'tool_specific',    -- Single tool API keys (admin-controlled)
  'user_service',     -- User OAuth identities (Google Workspace, GitHub, Slack)
  'custom'            -- Arbitrary custom secrets
);
```

### 3.3 Schema: `agent_credential_binding`

N:M table controlling which agents can use which credentials.

```sql
CREATE TABLE agent_credential_binding (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  provider_credential_id UUID NOT NULL REFERENCES provider_credential(id) ON DELETE CASCADE,
  scope                  VARCHAR(255),         -- reserved for future use
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, provider_credential_id)
);
```

### 3.4 Schema: `credential_audit_log`

Tracks all credential lifecycle events.

```sql
CREATE TABLE credential_audit_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id        UUID REFERENCES user_account(id) ON DELETE SET NULL,
  provider_credential_id UUID REFERENCES provider_credential(id) ON DELETE SET NULL,
  event_type             TEXT NOT NULL,
  provider               TEXT,
  details                JSONB NOT NULL DEFAULT '{}',
  ip_address             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Event types:** `credential_created`, `credential_updated`, `credential_deleted`, `oauth_connected`, `oauth_disconnected`, `token_refreshed`, `token_expired`, `api_key_rotated`, `credential_accessed`, `credential_bound`, `credential_unbound`

---

## 4. Ownership & Access Control

### 4.1 Credential Ownership

```
user_account (owner)
  └── provider_credential (N credentials per user)
        └── agent_credential_binding (M agents can use this credential)
```

- Credentials are **owned by users** (`provider_credential.user_account_id`).
- Agents can **use** credentials via explicit binding rows.
- An agent can be bound to credentials from any user (if binding exists).

### 4.2 Authorization Rules

| Credential Class | Who can create? | Who can bind to an agent? |
|------------------|-----------------|--------------------------|
| `llm_provider` | User (their own) | User (their own credentials only) |
| `user_service` | User (OAuth flow) | User (their own credentials only) |
| `tool_specific` | Admin only | Admin only |

Enforcement in `agent-credentials.ts`:

```typescript
if (credential.credential_class === "tool_specific") {
  if (!principal.roles.includes("admin")) return 403
} else {
  if (credential.user_account_id !== principal.userId) return 403
}
```

---

## 5. Encryption Model

### 5.1 Two-Tier AES-256-GCM

```
CREDENTIAL_MASTER_KEY (env var)
  → SHA-256 → master_key (256-bit)
    → encrypts per-user keys → user_account.encryption_key_enc
      → per-user key (random 256-bit)
        → encrypts credentials → provider_credential.*_enc columns
```

- **Algorithm:** AES-256-GCM, 12-byte IV, 16-byte auth tag
- **Storage format:** `base64(iv).base64(authTag).base64(ciphertext)`
- **Per-user isolation:** Compromise of one user's key does not affect others
- **Master key never in DB:** Derived at runtime from env var

### 5.2 What's Encrypted

| Column | Contains |
|--------|----------|
| `access_token_enc` | OAuth access token |
| `refresh_token_enc` | OAuth refresh token |
| `api_key_enc` | API key (for `api_key` type) |
| `encryption_key_enc` (on `user_account`) | User's per-user key |

### 5.3 Multi-User Scale

The two-tier model scales to multi-user without changes:

1. Each user gets a unique per-user key on first credential creation.
2. The master key is the only key management burden for the operator.
3. Future: replace `deriveMasterKey(SHA-256)` with a KMS or HSM-backed key derivation for production deployments.

---

## 6. Injection Protocol

### 6.1 LLM Credential Injection

At job execution time in `agent-execute.ts`:

```
1. Query agent_credential_binding WHERE agent_id AND credential_class = 'llm_provider'
2. Filter to credentials owned by job.userId
3. credentialService.getAccessToken(userId, provider) → decrypted token
4. Attach to task.constraints.llmCredential
5. HttpLlmBackend creates a one-shot API client with the per-job token
6. Fallback: if no binding exists, use env var LLM_API_KEY
```

**Type:**

```typescript
interface LlmCredentialRef {
  provider: string        // "anthropic" | "openai" | ...
  token: string           // decrypted access token or API key
  credentialId: string    // for audit trail
}
```

### 6.2 Tool Credential Injection (User Service + Tool Secret)

For webhook tools and MCP tools:

```
1. Tool spec declares credentials[] references
2. Before execution, resolve each ref:
   - user_service → credentialService.getAccessToken(job.userId, ref.provider)
   - tool_specific → credentialService.getToolSecret(ref.provider)
3. Build resolved headers map
4. Inject as HTTP headers into webhook/MCP call
5. Audit log each access with { agent_id, job_id, tool_name, credential_id }
```

**Type:**

```typescript
interface ToolCredentialRef {
  credentialClass: "user_service" | "tool_specific"
  provider: string
  injectAs: "header" | "env"
  headerName?: string     // e.g., "Authorization"
  format?: "bearer" | "raw"
}
```

### 6.3 Security Constraints

- Decrypted tokens are held in memory **only** for the duration of the API call.
- Tokens must NEVER appear in: job `result`/`checkpoint` JSONB, session messages, log output (Pino), error messages sent to clients.
- Failed credential resolution fails the individual tool call, not the entire job.

---

## 7. Multi-Tenancy Model

### 7.1 Per-User Credential Isolation

User A and User B both connect Google Workspace. Same MCP server, different tokens.

Resolution at execution time:

```
1. Job payload carries userId (the user who initiated the job)
2. agent_credential_binding links agent to multiple credentials
3. At resolution, filter to credentials WHERE user_account_id = job.userId
4. The correct user's token is injected into the tool call
5. If the user has no credential for this provider: tool call fails with clear error
```

### 7.2 Tool Secrets (Shared)

Tool secrets are not user-specific. A single `brave` API key is shared across all agents that have a binding to it. The secret is owned by the admin who created it, but any bound agent can use it regardless of the job's userId.

---

## 8. Refresh & Rotation Lifecycle

### 8.1 Just-in-Time Refresh

`CredentialService.getAccessToken()` checks `token_expires_at` with a 5-minute buffer. If expired, it:

1. Decrypts the refresh token
2. Calls the provider's token endpoint with `grant_type=refresh_token`
3. Encrypts and stores the new access token (and new refresh token if rotated)
4. Updates `token_expires_at`, `last_refresh_at`
5. Audit logs `token_refreshed`

### 8.2 Proactive Refresh Worker

A Graphile Worker cron task (`credential-refresh`) runs every 15 minutes:

```
1. Query credentials WHERE credential_type = 'oauth'
     AND status = 'active'
     AND refresh_token_enc IS NOT NULL
     AND token_expires_at < now() + interval '30 minutes'
2. For each: attempt refresh
3. On failure: increment error_count, set last_error
4. After 3 consecutive failures: set status = 'error'
```

### 8.3 Rotation Policy

- **OAuth tokens:** Auto-refreshed via JIT + proactive worker.
- **API keys:** Manual rotation via `PUT /credentials/:id/rotate` (admin).
- **Tool secrets:** Informational `rotation_due` audit event after 90 days without update.

**Who refreshes?** Cortex Plane, not the MCP server. The MCP server receives fresh tokens via header injection.

---

## 9. Audit Trail

### 9.1 Credential Audit Log

Every credential lifecycle event is logged in `credential_audit_log`:

| Event | Context |
|-------|---------|
| `credential_created` | Provider, credential class |
| `credential_accessed` | `agent_id`, `job_id`, `tool_name` (enriched) |
| `credential_bound` | `agent_id`, `granted_by` |
| `credential_unbound` | `agent_id` |
| `token_refreshed` | Provider, success/failure |
| `api_key_rotated` | Provider, rotated_by |

### 9.2 Query API

```
GET /credentials/audit?credentialId=uuid&agentId=uuid&eventType=credential_accessed&limit=50
```

Supports filtering by `credentialId`, `agentId` (via `details->>'agent_id'`), and `eventType`.

---

## 10. API Surface

### 10.1 Credential CRUD

```
GET    /credentials/providers          — list supported providers with metadata
GET    /credentials                    — list user's credentials (no secrets)
GET    /credentials?class=tool_secret  — filter by credential class
POST   /credentials/api-key            — store API key credential
POST   /credentials/tool-secret        — store tool secret (admin only)
PUT    /credentials/:id/rotate         — rotate tool secret (admin only)
DELETE /credentials/:id                — delete credential
GET    /credentials/audit              — credential audit log
```

### 10.2 Agent Credential Binding

```
POST   /agents/:agentId/credentials           — bind credential to agent
GET    /agents/:agentId/credentials           — list agent's bound credentials
DELETE /agents/:agentId/credentials/:credId   — unbind credential from agent
```

---

## 11. Migration Plan

### 11.1 Completed Migrations

| Migration | Description | Ticket |
|-----------|-------------|--------|
| 009 | OAuth foundation: `provider_credential`, `credential_audit_log`, `dashboard_session` | — |
| 016 | `credential_class` enum + `agent_credential_binding` table | #272 |
| 017 | Add `user_service` to `credential_class` enum | #275 |

### 11.2 No Additional Schema Migrations Required

The credential taxonomy is fully represented by migrations 009 + 016 + 017. Remaining work is service logic, routes, injection pipeline, and UI — not schema changes.

---

## 12. Answers to Spike Questions

| # | Question | Decision |
|---|----------|----------|
| 1 | **Storage model:** One table or separate? | **One table** with `credential_class` type column. Encryption/audit/lifecycle logic is identical. |
| 2 | **Encryption:** Scale to multi-user? | **Unchanged.** Two-tier AES-256-GCM (master → per-user → credential) already handles multi-user. |
| 3 | **Injection:** How do credentials reach MCP servers? | **HTTP headers** via webhook tool calls. LLM credentials via per-job `TaskConstraints.llmCredential`. |
| 4 | **Multi-tenancy:** Same MCP server, different user tokens? | **Per-job userId resolution.** `agent_credential_binding` + filter by `user_account_id = job.userId`. |
| 5 | **Rotation/refresh:** Who refreshes? | **Cortex Plane.** JIT in `getAccessToken()` + proactive 15-min cron worker. |
| 6 | **Scoping:** Agent A has Calendar but not Gmail? | **`agent_credential_binding`** per credential + **`agent_tool_binding`** per tool with `data_scope` JSONB. |
| 7 | **Audit:** Compliance trail? | **`credential_audit_log`** with enriched `details` JSONB carrying `agent_id`, `job_id`, `tool_name`. |

---

## 13. Implementation Tickets

Epic child issues of #263, ordered for WIP=1:

| # | Issue | Title | Size | Status | Depends on |
|---|-------|-------|------|--------|------------|
| 1 | #272 | Migration 016: `credential_class` + `agent_credential_binding` | S | Closed | — |
| 2 | #273 | Extend CredentialService for `credential_class` + tool secrets | M | Open | #272 |
| 3 | #274 | Agent credential binding CRUD routes + service | M | Closed | #272, #273 |
| 4 | #275 | User service OAuth flow (Google Workspace, GitHub, Slack) | M | Closed | #273 |
| 5 | #276 | Credential injection into execution pipeline | L | Open | #273, #274 |
| 6 | #277 | Tool secret admin routes + dashboard panel | M | Open | #273 |
| 7 | #278 | Dashboard credential binding UI | M | Open | #274, #277 |
| 8 | #279 | Audit trail enrichment (agent/job/tool context) | S | Open | #276 |
| 9 | #280 | Proactive refresh worker (Graphile scheduled task) | S | Open | #276 |

**Critical path:** #272 → #273 → #274 + #275 (parallel) → #276 → #279/#280

**Total estimated effort:** ~35-50 hours across 5 S + 3 M + 1 L tickets.
