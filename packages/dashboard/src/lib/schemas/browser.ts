import { z } from "zod"

export const BrowserSessionStatusSchema = z.enum([
  "connecting",
  "connected",
  "disconnected",
  "error",
])

export const BrowserEventTypeSchema = z.enum([
  "GET",
  "CLICK",
  "CONSOLE",
  "SNAPSHOT",
  "NAVIGATE",
  "ERROR",
])

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
  agent_id: z.string(),
  vnc_url: z.string().nullable(),
  status: BrowserSessionStatusSchema,
  tabs: z.array(BrowserTabSchema),
  latency_ms: z.number(),
  last_heartbeat: z.string().optional(),
})

export const BrowserEventSchema = z.object({
  id: z.string(),
  type: BrowserEventTypeSchema,
  timestamp: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  message: z.string().optional(),
  duration_ms: z.number().optional(),
  severity: BrowserEventSeveritySchema.optional(),
})

export const ScreenshotSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  timestamp: z.string(),
  thumbnail_url: z.string(),
  full_url: z.string(),
  dimensions: z.object({
    width: z.number(),
    height: z.number(),
  }),
})

export const ScreenshotListResponseSchema = z.object({
  screenshots: z.array(ScreenshotSchema),
})

export const BrowserEventListResponseSchema = z.object({
  events: z.array(BrowserEventSchema),
})

// ---------------------------------------------------------------------------
// Screenshot capture response (POST /observe/screenshot)
// ---------------------------------------------------------------------------

export const CaptureScreenshotResponseSchema = z.object({
  timestamp: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  file_path: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Trace state & control responses
// ---------------------------------------------------------------------------

export const TraceStatusSchema = z.enum(["idle", "recording"])

export const TraceStateSchema = z.object({
  status: TraceStatusSchema,
  started_at: z.string().optional(),
  options: z
    .object({
      snapshots: z.boolean().optional(),
      screenshots: z.boolean().optional(),
      network: z.boolean().optional(),
      console: z.boolean().optional(),
    })
    .optional(),
})

export const TraceStartResponseSchema = z.object({
  status: z.string(),
  started_at: z.string().optional(),
})

export const TraceStopResponseSchema = z.object({
  status: z.string(),
  file_path: z.string().optional(),
  duration_ms: z.number().optional(),
})

export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatusSchema>
export type BrowserEventType = z.infer<typeof BrowserEventTypeSchema>
export type BrowserEventSeverity = z.infer<typeof BrowserEventSeveritySchema>
export type BrowserTab = z.infer<typeof BrowserTabSchema>
export type BrowserSession = z.infer<typeof BrowserSessionSchema>
export type BrowserEvent = z.infer<typeof BrowserEventSchema>
export type Screenshot = z.infer<typeof ScreenshotSchema>
export type CaptureScreenshotResponse = z.infer<typeof CaptureScreenshotResponseSchema>
export type TraceStatus = z.infer<typeof TraceStatusSchema>
export type TraceState = z.infer<typeof TraceStateSchema>
export type TraceStartResponse = z.infer<typeof TraceStartResponseSchema>
export type TraceStopResponse = z.infer<typeof TraceStopResponseSchema>
