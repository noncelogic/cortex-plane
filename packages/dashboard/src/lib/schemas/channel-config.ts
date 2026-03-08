import { z } from "zod"

export const BotMetadataSchema = z.object({
  bot_id: z.string(),
  username: z.string(),
  display_name: z.string(),
})

export const ChannelConfigSchema = z.object({
  id: z.string(),
  type: z.enum(["telegram", "discord", "whatsapp"]),
  name: z.string(),
  bot_metadata: BotMetadataSchema.nullable().optional(),
  enabled: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const ChannelConfigListResponseSchema = z.object({
  channels: z.array(ChannelConfigSchema),
})

export const ChannelConfigResponseSchema = z.object({
  channel: ChannelConfigSchema,
})

export type ChannelConfigSummary = z.infer<typeof ChannelConfigSchema>
