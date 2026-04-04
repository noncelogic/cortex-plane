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
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
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
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

export type SessionMessage = z.infer<typeof SessionMessageSchema>

export const MessageListResponseSchema = z.object({
  messages: z.array(SessionMessageSchema),
  count: z.number(),
})

// ---------------------------------------------------------------------------
// Chat message status — used by the chat panel UI for visual indicators
// ---------------------------------------------------------------------------

/**
 * Tracks the lifecycle of a chat message through the system:
 * - sending: message submitted, waiting for server acknowledgment
 * - sent: server accepted, job created (for user messages)
 * - streaming: assistant response is being received incrementally
 * - complete: final response received
 * - error: job failed or request error
 * - approval-needed: job requires human approval before continuing
 */
export type ChatMessageStatus =
  | "sending"
  | "sent"
  | "streaming"
  | "complete"
  | "error"
  | "approval-needed"

// ---------------------------------------------------------------------------
// Chat response schemas
// ---------------------------------------------------------------------------

export const ChatResponseSchema = z.object({
  job_id: z.string(),
  session_id: z.string(),
  status: z.string(),
  response: z.string().nullable().optional(),
  message: z.string().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string(),
    })
    .optional(),
  approval_needed: z.boolean().optional(),
})

export type ChatResponse = z.infer<typeof ChatResponseSchema>

export const SessionClearResponseSchema = z.object({
  id: z.string(),
  status: z.literal("ended"),
  action: z.literal("cleared"),
})

// Backward-compatible alias (deprecated name)
export const SessionDeleteResponseSchema = SessionClearResponseSchema
