import { z } from "zod"

export const ProviderModelSchema = z.object({
  id: z.string(),
  label: z.string(),
})

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  authType: z.enum(["oauth", "api_key"]),
  description: z.string(),
  credentialClass: z.string().optional(),
  oauthConnectMode: z.enum(["redirect", "popup", "code_paste"]).optional(),
  models: z.array(ProviderModelSchema).optional(),
})

export const CredentialSchema = z.object({
  id: z.string(),
  provider: z.string(),
  credentialType: z.string(),
  credentialClass: z.string().optional(),
  toolName: z.string().nullable().optional(),
  displayLabel: z.string().nullable(),
  maskedKey: z.string().nullable(),
  status: z.string(),
  accountId: z.string().nullable().optional(),
  scopes: z.array(z.string()).nullable().optional(),
  tokenExpiresAt: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable().optional(),
  errorCount: z.number().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
})

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
})

export const CredentialListResponseSchema = z.object({
  credentials: z.array(CredentialSchema),
})

export const OAuthInitResultSchema = z.object({
  authUrl: z.string(),
  codeVerifier: z.string(),
  state: z.string(),
})

export const CredentialTestResultSchema = z.object({
  status: z.enum(["connected", "token_expired", "auth_failed", "rate_limited", "error"]),
  message: z.string(),
  tokenExpiresAt: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
})

export const OAuthConnectExchangeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    provider: z.string(),
    accountId: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    provider: z.string(),
    accountId: z.string().nullable(),
    verification: CredentialTestResultSchema,
  }),
])

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>
export type Credential = z.infer<typeof CredentialSchema>
export type OAuthInitResult = z.infer<typeof OAuthInitResultSchema>
export type CredentialTestResult = z.infer<typeof CredentialTestResultSchema>
export type OAuthConnectExchangeResult = z.infer<typeof OAuthConnectExchangeResultSchema>
