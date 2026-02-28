/**
 * OAuth Service — handles OAuth2 authorization flows.
 *
 * Supports two categories of OAuth providers:
 *
 * 1. **Dashboard Login** (Google, GitHub)
 *    Authorization Code flow → user profile → session creation.
 *
 * 2. **LLM Provider Credentials** (Google Antigravity, OpenAI Codex)
 *    Authorization Code + PKCE flow → token storage → server-side refresh.
 *
 * State parameter includes a random nonce + flow type + provider,
 * HMAC-signed to prevent CSRF.
 */

import { createHash, createHmac, randomBytes } from "node:crypto"

import type { OAuthProviderConfig } from "../config.js"

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

// ---------------------------------------------------------------------------
// OAuth state parameter (CSRF protection)
// ---------------------------------------------------------------------------

export interface OAuthState {
  nonce: string
  provider: string
  flow: "login" | "connect"
  codeVerifier?: string
}

/**
 * Serialize and HMAC-sign an OAuth state parameter.
 */
export function encodeOAuthState(state: OAuthState, secret: string): string {
  const payload = JSON.stringify(state)
  const payloadB64 = Buffer.from(payload).toString("base64url")
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url")
  return `${payloadB64}.${sig}`
}

/**
 * Verify and deserialize an OAuth state parameter.
 */
export function decodeOAuthState(encoded: string, secret: string): OAuthState | null {
  const dotIdx = encoded.indexOf(".")
  if (dotIdx === -1) return null

  const payloadB64 = encoded.slice(0, dotIdx)
  const sig = encoded.slice(dotIdx + 1)

  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url")
  if (sig !== expected) return null

  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf-8")
    return JSON.parse(json) as OAuthState
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Provider-specific OAuth URL builders
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USERINFO_URL = "https://api.github.com/user"

const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"

const OPENAI_CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize"
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"

const ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize"
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"

export interface OAuthUrls {
  authUrl: string
  tokenUrl: string
  userinfoUrl?: string
}

function getProviderUrls(provider: string, config?: OAuthProviderConfig): OAuthUrls {
  switch (provider) {
    case "google":
      return {
        authUrl: config?.authUrl ?? GOOGLE_AUTH_URL,
        tokenUrl: config?.tokenUrl ?? GOOGLE_TOKEN_URL,
        userinfoUrl: GOOGLE_USERINFO_URL,
      }
    case "github":
      return {
        authUrl: config?.authUrl ?? GITHUB_AUTH_URL,
        tokenUrl: config?.tokenUrl ?? GITHUB_TOKEN_URL,
        userinfoUrl: GITHUB_USERINFO_URL,
      }
    case "google-antigravity":
      return {
        authUrl: config?.authUrl ?? ANTIGRAVITY_AUTH_URL,
        tokenUrl: config?.tokenUrl ?? ANTIGRAVITY_TOKEN_URL,
      }
    case "openai-codex":
      return {
        authUrl: config?.authUrl ?? OPENAI_CODEX_AUTH_URL,
        tokenUrl: config?.tokenUrl ?? OPENAI_CODEX_TOKEN_URL,
      }
    case "anthropic":
      return {
        authUrl: config?.authUrl ?? ANTHROPIC_AUTH_URL,
        tokenUrl: config?.tokenUrl ?? ANTHROPIC_TOKEN_URL,
      }
    default:
      throw new Error(`Unknown OAuth provider: ${provider}`)
  }
}

export interface AuthorizeUrlParams {
  provider: string
  config: OAuthProviderConfig
  callbackUrl: string
  state: string
  codeChallenge?: string
  scopes?: string[]
}

/**
 * Build an authorization URL for the given provider.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const { provider, config, callbackUrl, state, codeChallenge, scopes } = params
  const urls = getProviderUrls(provider, config)

  const url = new URL(urls.authUrl)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", callbackUrl)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("state", state)

  if (scopes?.length) {
    url.searchParams.set("scope", scopes.join(" "))
  }

  // Provider-specific parameters
  switch (provider) {
    case "google":
      url.searchParams.set("scope", scopes?.join(" ") ?? "openid email profile")
      url.searchParams.set("access_type", "offline")
      url.searchParams.set("prompt", "consent")
      break
    case "github":
      url.searchParams.set("scope", scopes?.join(" ") ?? "read:user user:email")
      break
    case "google-antigravity":
      url.searchParams.set(
        "scope",
        scopes?.join(" ") ??
          "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
      )
      url.searchParams.set("access_type", "offline")
      url.searchParams.set("prompt", "consent")
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge)
        url.searchParams.set("code_challenge_method", "S256")
      }
      break
    case "openai-codex":
      url.searchParams.set("scope", scopes?.join(" ") ?? "openid profile email offline_access")
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge)
        url.searchParams.set("code_challenge_method", "S256")
      }
      break
    case "anthropic":
      url.searchParams.set(
        "scope",
        scopes?.join(" ") ?? "org:create_api_key user:profile user:inference",
      )
      url.searchParams.set("code", "true")
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge)
        url.searchParams.set("code_challenge_method", "S256")
      }
      break
  }

  return url.toString()
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type: string
  scope?: string
  id_token?: string
}

export interface TokenExchangeParams {
  provider: string
  config: OAuthProviderConfig
  code: string
  callbackUrl: string
  codeVerifier?: string
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(params: TokenExchangeParams): Promise<TokenResponse> {
  const { provider, config, code, callbackUrl, codeVerifier } = params
  const urls = getProviderUrls(provider, config)

  // Anthropic uses JSON body for token exchange
  if (provider === "anthropic") {
    const jsonBody: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
      client_id: config.clientId,
    }
    if (config.clientSecret) jsonBody.client_secret = config.clientSecret
    if (codeVerifier) jsonBody.code_verifier = codeVerifier

    const res = await fetch(urls.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonBody),
    })

    if (!res.ok) {
      const errorBody = await res.text()
      throw new Error(`Token exchange failed for ${provider}: ${res.status} ${errorBody}`)
    }

    return (await res.json()) as TokenResponse
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret)
  }

  if (codeVerifier) {
    body.set("code_verifier", codeVerifier)
  }

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" }
  // GitHub returns JSON only with Accept header
  if (provider === "github") {
    headers["Accept"] = "application/json"
  }

  const res = await fetch(urls.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Token exchange failed for ${provider}: ${res.status} ${errorBody}`)
  }

  return (await res.json()) as TokenResponse
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export interface RefreshTokenParams {
  provider: string
  config: OAuthProviderConfig
  refreshToken: string
}

/**
 * Refresh an OAuth access token using a refresh token.
 */
export async function refreshAccessToken(params: RefreshTokenParams): Promise<TokenResponse> {
  const { provider, config, refreshToken } = params
  const urls = getProviderUrls(provider, config)

  // Anthropic uses JSON body for token refresh
  if (provider === "anthropic") {
    const jsonBody: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }
    if (config.clientSecret) jsonBody.client_secret = config.clientSecret

    const res = await fetch(urls.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonBody),
    })

    if (!res.ok) {
      const errorBody = await res.text()
      throw new Error(`Token refresh failed for ${provider}: ${res.status} ${errorBody}`)
    }

    return (await res.json()) as TokenResponse
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret)
  }

  const res = await fetch(urls.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Token refresh failed for ${provider}: ${res.status} ${errorBody}`)
  }

  return (await res.json()) as TokenResponse
}

// ---------------------------------------------------------------------------
// User profile fetching
// ---------------------------------------------------------------------------

export interface OAuthUserProfile {
  providerId: string
  email: string
  displayName: string | null
  avatarUrl: string | null
}

/**
 * Fetch user profile from an OAuth provider using an access token.
 */
export async function fetchUserProfile(
  provider: string,
  accessToken: string,
): Promise<OAuthUserProfile> {
  switch (provider) {
    case "google":
      return fetchGoogleProfile(accessToken)
    case "github":
      return fetchGitHubProfile(accessToken)
    default:
      throw new Error(`User profile fetch not supported for provider: ${provider}`)
  }
}

async function fetchGoogleProfile(accessToken: string): Promise<OAuthUserProfile> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Google userinfo failed: ${res.status}`)

  const data = (await res.json()) as {
    id: string
    email: string
    name?: string
    picture?: string
  }

  return {
    providerId: data.id,
    email: data.email,
    displayName: data.name ?? null,
    avatarUrl: data.picture ?? null,
  }
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthUserProfile> {
  const res = await fetch(GITHUB_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) throw new Error(`GitHub userinfo failed: ${res.status}`)

  const data = (await res.json()) as {
    id: number
    login: string
    name?: string
    avatar_url?: string
    email?: string
  }

  // GitHub may not return email in profile — fetch from emails API
  let email = data.email
  if (!email) {
    const emailRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    })
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as {
        email: string
        primary: boolean
        verified: boolean
      }[]
      const primary = emails.find((e) => e.primary && e.verified)
      email = primary?.email ?? emails[0]?.email
    }
  }

  return {
    providerId: String(data.id),
    email: email ?? `${data.login}@users.noreply.github.com`,
    displayName: data.name ?? data.login,
    avatarUrl: data.avatar_url ?? null,
  }
}
