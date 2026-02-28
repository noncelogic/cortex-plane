import { z } from "zod"

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  auth_type: z.enum(["oauth", "api_key"]),
  description: z.string(),
})

export const CredentialSchema = z.object({
  id: z.string(),
  provider: z.string(),
  credential_type: z.string(),
  display_label: z.string().nullable(),
  masked_key: z.string().nullable(),
  status: z.string(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
})

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderInfoSchema),
})

export const CredentialListResponseSchema = z.object({
  credentials: z.array(CredentialSchema),
})

export const OAuthInitResultSchema = z.object({
  auth_url: z.string(),
  code_verifier: z.string(),
  state: z.string(),
})

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>
export type Credential = z.infer<typeof CredentialSchema>
export type OAuthInitResult = z.infer<typeof OAuthInitResultSchema>
