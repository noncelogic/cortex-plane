/**
 * Channel Adapter Types
 *
 * Core type definitions for the multi-channel messaging system.
 * Channel adapters (Telegram, Discord, etc.) implement ChannelAdapter
 * to provide a uniform interface between the control plane and messaging platforms.
 *
 * See: docs/spec.md — Section 15 (Channel Integration)
 */

// ──────────────────────────────────────────────────
// Message Types
// ──────────────────────────────────────────────────

export interface InboundMessage {
  channelType: string
  channelUserId: string
  chatId: string
  messageId: string
  text: string
  replyToMessageId?: string
  timestamp: Date
  metadata: Record<string, unknown>
}

export interface OutboundMessage {
  text: string
  replyToMessageId?: string
  inlineButtons?: InlineButton[][]
  media?: MediaAttachment
}

export interface InlineButton {
  text: string
  callbackData: string
}

export interface MediaAttachment {
  type: "photo" | "document" | "audio"
  url?: string
  buffer?: Buffer
  filename?: string
  mimeType?: string
}

// ──────────────────────────────────────────────────
// Approval & Callback Types
// ──────────────────────────────────────────────────

export interface ApprovalNotification {
  jobId: string
  agentName: string
  actionType: string
  actionDetail: string
  approveCallbackData: string
  rejectCallbackData: string
  expiresAt: Date
}

export interface CallbackQuery {
  channelType: string
  channelUserId: string
  chatId: string
  messageId: string
  data: string
  timestamp: Date
}

export interface VoiceSessionLifecycleEvent {
  voiceSessionId: string
  agentId: string
  sessionId: string
  userAccountId: string
  tokenExpiresAt: string
  timestamp: string
  reason?: "expired" | "replaced" | "shutdown" | "stopped"
}

// ──────────────────────────────────────────────────
// Channel Adapter Interface
// ──────────────────────────────────────────────────

export interface ChannelAdapter {
  readonly channelType: string

  start(): Promise<void>
  stop(): Promise<void>
  healthCheck(): Promise<boolean>
  /** Optional last channel heartbeat/activity timestamp for stale-connection detection. */
  getLastHeartbeatAt?(): Date | undefined

  sendMessage(chatId: string, message: OutboundMessage): Promise<string>
  sendApprovalRequest(chatId: string, request: ApprovalNotification): Promise<string>

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
  onCallback?(handler: (callback: CallbackQuery) => Promise<void>): void
  onVoiceSessionStart?(event: VoiceSessionLifecycleEvent): Promise<void> | void
  onVoiceSessionStop?(event: VoiceSessionLifecycleEvent): Promise<void> | void
}
