import { z } from "zod"

import { PaginationSchema } from "./common"

export const ContentStatusSchema = z.enum(["DRAFT", "IN_REVIEW", "QUEUED", "PUBLISHED"])

export const ContentTypeSchema = z.enum(["blog", "social", "newsletter", "report"])

export const ContentPieceSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: ContentTypeSchema,
  status: ContentStatusSchema,
  agent_id: z.string(),
  agent_name: z.string(),
  word_count: z.number(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  published_at: z.string().optional(),
  channel: z.string().optional(),
})

export const ContentPipelineStatsSchema = z.object({
  total_pieces: z.number(),
  published_today: z.number(),
  avg_review_time_ms: z.number(),
  pending_review: z.number(),
})

export const ContentListResponseSchema = z.object({
  content: z.array(ContentPieceSchema),
  pagination: PaginationSchema,
})

export type ContentStatus = z.infer<typeof ContentStatusSchema>
export type ContentType = z.infer<typeof ContentTypeSchema>
export type ContentPiece = z.infer<typeof ContentPieceSchema>
export type ContentPipelineStats = z.infer<typeof ContentPipelineStatsSchema>
