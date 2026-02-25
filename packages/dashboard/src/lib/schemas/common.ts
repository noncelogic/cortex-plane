import { z } from "zod"

export const PaginationSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
})

export type Pagination = z.infer<typeof PaginationSchema>
