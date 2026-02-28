import { z } from "zod"

export const PaginationSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
})

export type Pagination = z.infer<typeof PaginationSchema>
