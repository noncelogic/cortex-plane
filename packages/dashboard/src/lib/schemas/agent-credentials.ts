import { z } from "zod"

export const AgentCredentialBindingSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  credentialClass: z.string(),
  provider: z.string(),
  displayLabel: z.string().nullable(),
  status: z.string(),
  grantedAt: z.string(),
})

export const AgentCredentialBindingListResponseSchema = z.object({
  bindings: z.array(AgentCredentialBindingSchema),
})

export type AgentCredentialBinding = z.infer<typeof AgentCredentialBindingSchema>
