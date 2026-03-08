import { z } from "zod"

// ---------------------------------------------------------------------------
// Session schemas
// ---------------------------------------------------------------------------

export const SessionSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  user_account_id: z.string().nullable().optional(),
  channel_id: z.string().nullable().optional(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

export type Session = z.infer<typeof SessionSchema>

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  count: z.number(),
})

// ---------------------------------------------------------------------------
// Message schemas
// ---------------------------------------------------------------------------

export const SessionMessageSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  created_at: z.string(),
})

export type SessionMessage = z.infer<typeof SessionMessageSchema>

export const MessageListResponseSchema = z.object({
  messages: z.array(SessionMessageSchema),
  count: z.number(),
})

// ---------------------------------------------------------------------------
// Chat response schemas
// ---------------------------------------------------------------------------

export const ChatResponseSchema = z.object({
  job_id: z.string(),
  session_id: z.string(),
  status: z.string(),
  response: z.string().nullable().optional(),
  message: z.string().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string(),
    })
    .optional(),
})

export type ChatResponse = z.infer<typeof ChatResponseSchema>

export const SessionDeleteResponseSchema = z.object({
  id: z.string(),
  status: z.literal("ended"),
})
