import { z } from "zod"

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  authType: z.enum(["oauth", "api_key"]),
  description: z.string(),
})

export const CredentialSchema = z.object({
  id: z.string(),
  provider: z.string(),
  credentialType: z.string(),
  displayLabel: z.string().nullable(),
  maskedKey: z.string().nullable(),
  status: z.string(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
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

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>
export type Credential = z.infer<typeof CredentialSchema>
export type OAuthInitResult = z.infer<typeof OAuthInitResultSchema>
