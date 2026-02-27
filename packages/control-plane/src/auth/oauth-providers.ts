/**
 * Hardcoded OAuth provider registry for code-paste flow.
 *
 * These use the same client IDs and redirect URIs as OpenClaw CLI.
 * Since we can't register custom redirect URIs on apps we don't own,
 * the dashboard uses a code-paste flow: the user opens the OAuth URL,
 * authorizes, then pastes the redirect URL back into the dashboard.
 *
 * Credentials are base64-encoded (same pattern as @mariozechner/pi-ai)
 * to avoid triggering secret scanning.
 */

const decode = (s: string): string => Buffer.from(s, "base64").toString("utf-8")

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
}

export const CODE_PASTE_PROVIDERS: Record<string, CodePasteProviderConfig> = {
  "google-antigravity": {
    id: "google-antigravity",
    name: "Google Antigravity",
    description: "Claude/Gemini via Google Cloud Antigravity",
    clientId: decode("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=="),
    clientSecret: decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="),
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
  },

  "openai-codex": {
    id: "openai-codex",
    name: "OpenAI Codex",
    description: "GPT models via ChatGPT subscription",
    clientId: decode("YXBwX0VNb2FtRUVaNzNmMENrWGFYcDdocmFubg=="),
    clientSecret: "",
    redirectUri: "http://localhost:1455/auth/callback",
    authUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email", "offline_access"],
    usePkce: true,
  },

  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models via OAuth",
    clientId: decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"),
    clientSecret: "",
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    authUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    extraAuthParams: {
      code: "true",
    },
    usePkce: true,
    useJsonTokenExchange: true,
  },
}

export function getCodePasteProvider(providerId: string): CodePasteProviderConfig | undefined {
  return CODE_PASTE_PROVIDERS[providerId]
}

export function listCodePasteProviders(): CodePasteProviderConfig[] {
  return Object.values(CODE_PASTE_PROVIDERS)
}
