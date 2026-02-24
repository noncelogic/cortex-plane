export type EventType =
  | "LLM_REQUEST"
  | "LLM_RESPONSE"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "CHECKPOINT"
  | "ERROR"
  | "STEERING"
  | "APPROVAL_REQUEST"
  | "APPROVAL_DECISION"
  | "SESSION_START"
  | "SESSION_END"

export interface BufferEvent {
  version: "1.0"
  timestamp: string
  jobId: string
  sessionId: string
  agentId: string
  sequence: number
  type: EventType
  data: Record<string, unknown>
  crc32?: number
}

export interface SessionMetadata {
  jobId: string
  agentId: string
  sessionId: string
  startedAt: string
  basePath: string
  sessionNumber: number
}

export interface RecoveryState {
  lastCheckpoint: BufferEvent | null
  eventsSinceCheckpoint: BufferEvent[]
  sessionFile: string
}

export interface BufferScanResult {
  events: BufferEvent[]
  corruptedLines: number
  lastLineTruncated: boolean
}
