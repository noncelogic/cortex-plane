import { z } from "zod"

export const AgentChannelBindingSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  channel_type: z.string(),
  chat_id: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
})

export const AgentChannelBindingListResponseSchema = z.object({
  bindings: z.array(AgentChannelBindingSchema),
})

export type AgentChannelBinding = z.infer<typeof AgentChannelBindingSchema>
