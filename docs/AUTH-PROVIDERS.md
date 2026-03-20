# Cortex Plane — Auth & LLM Provider Reference

## Architecture

Cortex Plane mirrors OpenClaw's auth-profiles pattern:

- **OAuth providers**: Client credentials embedded in code (no env vars needed)
- **API key providers**: User enters key in Settings UI, encrypted and stored in DB
- **Per-agent binding**: Each agent binds to a specific credential for LLM access

## Dashboard Login (redirect-based OAuth)

| Provider | Env Vars Required                                      | Flow                                    |
| -------- | ------------------------------------------------------ | --------------------------------------- |
| GitHub   | `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` | Redirect to GitHub → callback → session |
| Google   | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET` | Redirect to Google → callback → session |

These are the only OAuth providers that need env vars — they handle user authentication, not LLM access.

## LLM Providers — OAuth (code-paste flow)

These use embedded client credentials from `CODE_PASTE_PROVIDERS` in `oauth-providers.ts`.
**No env vars needed.**

| Provider ID          | Name               | Source           | Auth Pattern                       |
| -------------------- | ------------------ | ---------------- | ---------------------------------- |
| `google-antigravity` | Google Antigravity | OpenClaw `pi-ai` | Google OAuth2 + PKCE, Bearer token |
| `openai-codex`       | OpenAI Codex       | OpenClaw `pi-ai` | OpenAI OAuth2 + PKCE               |
| `github-copilot`     | GitHub Copilot     | GitHub OAuth     | GitHub OAuth2, no PKCE             |
| `anthropic`          | Anthropic          | OpenClaw `pi-ai` | Code-paste only (device code)      |

### Code-Paste Flow

1. Dashboard calls `GET /auth/connect/:provider/init` → gets `authUrl`, `codeVerifier`, `state`
2. User opens `authUrl` in popup/new tab, authorizes
3. Provider redirects to `localhost:*` (unreadable by dashboard since it's remote)
4. User pastes the redirect URL back into the dashboard
5. Dashboard calls `POST /auth/connect/:provider/exchange` with pasted URL + `codeVerifier`
6. Control-plane exchanges code for tokens, encrypts, stores in DB

### Dashboard Flow Selection

`GET /credentials/providers` now exposes `oauthConnectMode` so the dashboard uses
provider-declared behavior instead of hardcoded ID lists:

| `oauthConnectMode` | Meaning |
| ------------------ | ------- |
| `redirect` | Browser redirect flow via `/api/auth/connect/:provider` |
| `popup` | Popup authorize flow with localhost callback auto-capture when readable |
| `code_paste` | Manual pasted callback/code flow; skip popup capture assumptions |

### Token Refresh

- Antigravity: Google OAuth2 refresh flow (Bearer auth)
- OpenAI Codex: OpenAI OAuth2 refresh flow
- Anthropic: Anthropic OAuth2 refresh flow (apiKey, not Bearer — see PR #618)

## LLM Providers — API Key

| Provider         | How to Add                    | Storage         |
| ---------------- | ----------------------------- | --------------- |
| Anthropic        | Settings page → "Add API Key" | Encrypted in DB |
| OpenAI           | Settings page → "Add API Key" | Encrypted in DB |
| Google AI Studio | Settings page → "Add API Key" | Encrypted in DB |

API keys are encrypted with `CREDENTIAL_MASTER_KEY` (AES-256-GCM) before storage.

## OpenClaw Parity Status

| OpenClaw Provider    | Cortex Plane              | Status                                     |
| -------------------- | ------------------------- | ------------------------------------------ |
| `anthropic`          | ✅ `CODE_PASTE_PROVIDERS` | Working (code-paste only)                  |
| `google-antigravity` | ✅ `CODE_PASTE_PROVIDERS` | ⚠️ Settings UI routes to wrong flow (#640) |
| `openai-codex`       | ✅ `CODE_PASTE_PROVIDERS` | ⚠️ Settings UI routes to wrong flow (#640) |
| `github-copilot`     | ✅ `CODE_PASTE_PROVIDERS` | GitHub OAuth2, no PKCE                     |
| `google-gemini-cli`  | ❌ Not added              | Tracked in #643                            |
| API key (any)        | ✅ Settings UI            | Needs e2e verification (#644)              |

## Agent Credential Binding

1. User connects a provider on Settings page → credential stored in DB
2. User creates/edits an agent → binds a credential to the agent
3. Agent execution uses the bound credential's token/key for LLM calls
4. Token refresh happens automatically for OAuth credentials

## Files

| File                                                    | Purpose                                             |
| ------------------------------------------------------- | --------------------------------------------------- |
| `packages/control-plane/src/auth/oauth-providers.ts`    | Code-paste provider registry (embedded credentials) |
| `packages/control-plane/src/auth/oauth-service.ts`      | Token exchange and refresh                          |
| `packages/control-plane/src/auth/credential-service.ts` | Credential CRUD, encryption, health checks          |
| `packages/control-plane/src/routes/auth.ts`             | All auth routes (login, connect, code-paste)        |
| `packages/control-plane/src/config.ts`                  | Env var parsing for redirect-based OAuth            |
| `packages/dashboard/src/app/settings/page.tsx`          | Provider connection UI                              |
| `packages/dashboard/src/hooks/use-oauth-popup.ts`       | Popup/code-paste flow hook                          |
