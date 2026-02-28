# TASK: Fix Anthropic OAuth Token Exchange (#239)

## Problem

Anthropic OAuth token exchange fails with `400 Invalid request format`.

Error:

```
Token exchange failed for anthropic: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid request format"}}
```

## Root Cause

Compared against the pi-ai SDK (`@mariozechner/pi-ai`), OpenClaw's reference OAuth implementation.

Reference file (read this first):

```
~/openclaw/node_modules/.pnpm/@mariozechner+pi-ai@0.54.1_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-ai/dist/utils/oauth/anthropic.js
```

Two issues:

### 1. Missing `state` in token exchange body

pi-ai sends `state` in the Anthropic token exchange JSON body. Our code does not.

pi-ai token exchange body:

```js
{
  grant_type: "authorization_code",
  client_id: CLIENT_ID,
  code: code,
  state: state,           // <-- WE'RE MISSING THIS
  redirect_uri: REDIRECT_URI,
  code_verifier: verifier,
}
```

Our code at `packages/control-plane/src/auth/oauth-service.ts` line ~237:

```ts
const jsonBody: Record<string, string> = {
  grant_type: "authorization_code",
  code,
  redirect_uri: callbackUrl,
  client_id: config.clientId,
}
// NO state field
```

### 2. Anthropic state = PKCE verifier

pi-ai uses the PKCE code verifier as the OAuth `state` parameter in the auth URL. Our code uses `crypto.randomUUID()`.

In `packages/control-plane/src/routes/auth.ts` line ~414:

```ts
const state = crypto.randomUUID() // Should be: provider === "anthropic" ? codeVerifier : crypto.randomUUID()
```

## Fix

### File 1: `packages/control-plane/src/auth/oauth-service.ts`

- Add `state?: string` to `TokenExchangeParams` interface (around line 220)
- In the Anthropic JSON body block (around line 247), add: `if (state) jsonBody.state = state`

### File 2: `packages/control-plane/src/routes/auth.ts`

- In the init endpoint (around line 414), change:
  `const state = crypto.randomUUID()` → `const state = provider === "anthropic" ? codeVerifier : crypto.randomUUID()`
- In the exchange endpoint (around line 510), add `state: parsed.state` to the `exchangeCodeForTokens` call

## Constraints

- Run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` before committing
- Use conventional commit: `fix(auth): include state in Anthropic OAuth token exchange`
- Do NOT change any other files — this is a surgical 4-line fix

When completely finished, run: openclaw system event --text 'JOB_DONE:issue-239' --mode now
