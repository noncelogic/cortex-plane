/**
 * OAuth provider registry for code-paste flow.
 *
 * These use the same client IDs and redirect URIs as OpenClaw CLI.
 * Since we can't register custom redirect URIs on apps we don't own,
 * the dashboard uses a code-paste flow: the user opens the OAuth URL,
 * authorizes, then pastes the redirect URL back into the dashboard.
 *
 * Credentials are read from environment variables — never hardcoded.
 */

export interface CodePasteProviderConfig {
  id: string
  name: string
  description: string
  clientId: string
  clientSecret: string
  redirectUri: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  /** Extra query params for the authorization URL. */
  extraAuthParams?: Record<string, string>
  /** Use PKCE S256 challenge. */
  usePkce: boolean
  /** Use JSON body instead of form-encoded for token exchange. */
  useJsonTokenExchange?: boolean
  /**
   * When true, the provider does not redirect to a localhost URL after
   * authorization. Instead it displays a device code that the user must
   * copy and paste back into the dashboard. The popup flow is skipped
   * entirely and a code-paste input is shown immediately.
   */
  codePasteOnly?: boolean
}

function buildCodePasteProviders(): Record<string, CodePasteProviderConfig> {
  const providers: Record<string, CodePasteProviderConfig> = {}

  // Google Antigravity
  if (process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_ID) {
    providers["google-antigravity"] = {
      id: "google-antigravity",
      name: "Google Antigravity",
      description: "Claude/Gemini via Google Cloud Antigravity",
      clientId: process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_ID,
      clientSecret: process.env.OAUTH_GOOGLE_ANTIGRAVITY_CLIENT_SECRET ?? "",
      redirectUri: "http://localhost:51121/oauth-callback",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      ],
      extraAuthParams: {
        access_type: "offline",
        prompt: "consent",
      },
      usePkce: true,
    }
  }

  // Google Gemini CLI
  if (process.env.OAUTH_GEMINI_CLI_CLIENT_ID) {
    providers["google-gemini-cli"] = {
      id: "google-gemini-cli",
      name: "Google Gemini CLI",
      description: "Gemini models via Google Gemini CLI OAuth",
      clientId: process.env.OAUTH_GEMINI_CLI_CLIENT_ID,
      clientSecret: process.env.OAUTH_GEMINI_CLI_CLIENT_SECRET ?? "",
      redirectUri: "http://localhost:8085",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      usePkce: true,
    }
  }

  // OpenAI Codex
  if (process.env.OAUTH_OPENAI_CODEX_CLIENT_ID) {
    providers["openai-codex"] = {
      id: "openai-codex",
      name: "OpenAI Codex",
      description: "GPT models via ChatGPT subscription",
      clientId: process.env.OAUTH_OPENAI_CODEX_CLIENT_ID,
      clientSecret: process.env.OAUTH_OPENAI_CODEX_CLIENT_SECRET ?? "",
      redirectUri: "http://localhost:1455/auth/callback",
      authUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scopes: ["openid", "profile", "email", "offline_access"],
      usePkce: true,
    }
  }

  // GitHub Copilot
  if (process.env.OAUTH_GITHUB_COPILOT_CLIENT_ID) {
    providers["github-copilot"] = {
      id: "github-copilot",
      name: "GitHub Copilot",
      description: "GPT/Claude models via GitHub Copilot subscription",
      clientId: process.env.OAUTH_GITHUB_COPILOT_CLIENT_ID,
      clientSecret: process.env.OAUTH_GITHUB_COPILOT_CLIENT_SECRET ?? "",
      redirectUri: "http://localhost:1234",
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["read:user"],
      usePkce: false,
    }
  }

  // Anthropic
  if (process.env.OAUTH_ANTHROPIC_CLIENT_ID) {
    providers["anthropic"] = {
      id: "anthropic",
      name: "Anthropic",
      description: "Claude models via OAuth",
      clientId: process.env.OAUTH_ANTHROPIC_CLIENT_ID,
      clientSecret: process.env.OAUTH_ANTHROPIC_CLIENT_SECRET ?? "",
      redirectUri: "https://console.anthropic.com/oauth/code/callback",
      authUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://console.anthropic.com/v1/oauth/token",
      scopes: ["org:create_api_key", "user:profile", "user:inference"],
      extraAuthParams: {
        code: "true",
      },
      usePkce: true,
      useJsonTokenExchange: true,
      codePasteOnly: true,
    }
  }

  return providers
}

export const CODE_PASTE_PROVIDERS: Record<string, CodePasteProviderConfig> =
  buildCodePasteProviders()

export function getCodePasteProvider(providerId: string): CodePasteProviderConfig | undefined {
  return CODE_PASTE_PROVIDERS[providerId]
}

export function listCodePasteProviders(): CodePasteProviderConfig[] {
  return Object.values(CODE_PASTE_PROVIDERS)
}

// ---------------------------------------------------------------------------
// User service provider registry (redirect-based OAuth flow)
// ---------------------------------------------------------------------------

import type { CredentialClass } from "../db/types.js"

export interface UserServiceProviderDef {
  id: string
  name: string
  description: string
  credentialClass: CredentialClass
  /** Default scopes requested during the OAuth authorize step. */
  defaultScopes: string[]
  /** Extra query params for the authorization URL. */
  extraAuthParams?: Record<string, string>
  /** Use PKCE S256 challenge. */
  usePkce: boolean
}

export const USER_SERVICE_PROVIDERS: Record<string, UserServiceProviderDef> = {
  "google-workspace": {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Google Calendar, Gmail, Drive (acting as the user)",
    credentialClass: "user_service",
    defaultScopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    extraAuthParams: {
      access_type: "offline",
      prompt: "consent",
    },
    usePkce: true,
  },

  "github-user": {
    id: "github-user",
    name: "GitHub (user)",
    description: "GitHub repos, issues, PRs (acting as the user)",
    credentialClass: "user_service",
    defaultScopes: ["repo", "read:user", "user:email"],
    usePkce: false, // GitHub OAuth does not support PKCE
  },

  "slack-user": {
    id: "slack-user",
    name: "Slack (user)",
    description: "Slack channels, messages (acting as the user)",
    credentialClass: "user_service",
    defaultScopes: ["channels:read", "chat:write", "users:read"],
    usePkce: false, // Slack v2 OAuth does not support PKCE
    extraAuthParams: {
      user_scope: "channels:read,chat:write,users:read",
    },
  },
}

export function getUserServiceProvider(providerId: string): UserServiceProviderDef | undefined {
  return USER_SERVICE_PROVIDERS[providerId]
}

export function listUserServiceProviders(): UserServiceProviderDef[] {
  return Object.values(USER_SERVICE_PROVIDERS)
}

/**
 * Check whether a provider ID belongs to a user service provider.
 */
export function isUserServiceProvider(providerId: string): boolean {
  return providerId in USER_SERVICE_PROVIDERS
}
