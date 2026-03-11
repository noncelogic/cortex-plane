import { z } from "zod"

export const ModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  providers: z.array(z.string()),
})

export const ModelListResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
})

export type ModelInfo = z.infer<typeof ModelInfoSchema>
