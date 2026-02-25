import { z } from "zod"

export const BrowserSessionStatusSchema = z.enum(["connecting", "connected", "disconnected", "error"])

export const BrowserEventTypeSchema = z.enum(["GET", "CLICK", "CONSOLE", "SNAPSHOT", "NAVIGATE", "ERROR"])

export const BrowserEventSeveritySchema = z.enum(["info", "warn", "error"])

export const BrowserTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  favicon: z.string().optional(),
  active: z.boolean(),
})

export const BrowserSessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  vncUrl: z.string().nullable(),
  status: BrowserSessionStatusSchema,
  tabs: z.array(BrowserTabSchema),
  latencyMs: z.number(),
  lastHeartbeat: z.string().optional(),
})

export const BrowserEventSchema = z.object({
  id: z.string(),
  type: BrowserEventTypeSchema,
  timestamp: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  message: z.string().optional(),
  durationMs: z.number().optional(),
  severity: BrowserEventSeveritySchema.optional(),
})

export const ScreenshotSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  timestamp: z.string(),
  thumbnailUrl: z.string(),
  fullUrl: z.string(),
  dimensions: z.object({
    width: z.number(),
    height: z.number(),
  }),
})

export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatusSchema>
export type BrowserEventType = z.infer<typeof BrowserEventTypeSchema>
export type BrowserEventSeverity = z.infer<typeof BrowserEventSeveritySchema>
export type BrowserTab = z.infer<typeof BrowserTabSchema>
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserEvent = z.infer<typeof BrowserEventSchema>
export type Screenshot = z.infer<typeof ScreenshotSchema>
