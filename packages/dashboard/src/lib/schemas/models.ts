import { z } from "zod"

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  providers: z.array(z.string()),
})

export const ProviderModelInfoSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  label: z.string(),
  api: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.string()),
  contextWindow: z.number(),
  maxTokens: z.number(),
  baseUrl: z.string(),
})

export const SupportedProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  authType: z.enum(["oauth", "api_key"]),
  oauthConnectMode: z.enum(["redirect", "popup", "code_paste"]).optional(),
  credentialClass: z.literal("llm_provider"),
  isOAuthBacked: z.boolean(),
  isStaticApiKey: z.boolean(),
})

export const ModelListResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  providerModels: z.array(ProviderModelInfoSchema),
  providers: z.array(SupportedProviderSchema),
})

export type ModelInfo = z.infer<typeof ModelInfoSchema>
export type ProviderModelInfo = z.infer<typeof ProviderModelInfoSchema>
export type SupportedProvider = z.infer<typeof SupportedProviderSchema>
