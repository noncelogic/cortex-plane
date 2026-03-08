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

export const BindingWithAgentSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_slug: z.string(),
  channel_type: z.string(),
  chat_id: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
})

export const ChannelBindingsResponseSchema = z.object({
  bindings: z.array(BindingWithAgentSchema),
})

export type BindingWithAgent = z.infer<typeof BindingWithAgentSchema>
