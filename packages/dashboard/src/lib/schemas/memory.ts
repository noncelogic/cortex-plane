import { z } from "zod"

export const MemoryRecordSchema = z.object({
  id: z.string(),
  type: z.enum(["fact", "preference", "event", "system_rule"]),
  content: z.string(),
  tags: z.array(z.string()),
  people: z.array(z.string()),
  projects: z.array(z.string()),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  confidence: z.number(),
  source: z.string(),
  createdAt: z.number(),
  accessCount: z.number(),
  lastAccessedAt: z.number(),
  score: z.number().optional(),
})

export const MemorySearchResponseSchema = z.object({
  results: z.array(MemoryRecordSchema),
})

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>
