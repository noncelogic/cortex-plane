/**
 * Execution Backend Types
 *
 * Core type definitions for the pluggable execution backend system.
 * Backends (Claude Code, Codex, Aider, etc.) implement ExecutionBackend
 * to provide a uniform interface between the control plane and coding models.
 *
 * See: docs/spikes/037-execution-backends.md
 */

// ──────────────────────────────────────────────────
// Task Types
// ──────────────────────────────────────────────────

export interface ExecutionTask {
  /** Unique task ID (UUIDv7). */
  id: string

  /** The job this task belongs to. */
  jobId: string

  /** The agent executing this task. */
  agentId: string

  /** What to do. */
  instruction: TaskInstruction

  /** What the backend needs to know. */
  context: TaskContext

  /** Resource and behavioral limits. */
  constraints: TaskConstraints
}

export interface TaskInstruction {
  /** The primary prompt text. Backend-agnostic natural language. */
  prompt: string

  /**
   * Structured goal type.
   * - 'code_edit': Modify existing files.
   * - 'code_generate': Create new files.
   * - 'code_review': Analyze code without modification.
   * - 'shell_command': Execute commands and report results.
   * - 'research': Gather information, no code changes.
   */
  goalType: "code_edit" | "code_generate" | "code_review" | "shell_command" | "research"

  /** Target file paths the task should focus on. */
  targetFiles?: string[]

  /** Previous conversation turns for multi-step tasks. */
  conversationHistory?: ConversationTurn[]
}

export interface ConversationTurn {
  role: "user" | "assistant"
  content: string
}

export interface TaskContext {
  /** Absolute path to the workspace root. */
  workspacePath: string

  /** Agent identity and persona (system prompt). */
  systemPrompt: string

  /** Relevant memories from Qdrant. */
  memories: string[]

  /** Files to preload. Key: relative path, Value: content. */
  relevantFiles: Record<string, string>

  /** Environment variables to expose. */
  environment: Record<string, string>
}

export interface TaskConstraints {
  /** Maximum execution time (ms). */
  timeoutMs: number

  /** Maximum tokens (input + output). */
  maxTokens: number

  /** LLM model identifier. */
  model: string

  /** Allowed tools (empty = no tools). */
  allowedTools: string[]

  /** Denied tools (takes precedence over allowed). */
  deniedTools: string[]

  /** Maximum LLM turns. */
  maxTurns: number

  /** Whether the backend may make network requests. */
  networkAccess: boolean

  /** Whether the backend may execute shell commands. */
  shellAccess: boolean
}

// ──────────────────────────────────────────────────
// Result Types
// ──────────────────────────────────────────────────

export type ExecutionStatus = "completed" | "failed" | "timed_out" | "cancelled"

export interface ExecutionResult {
  /** Task ID this result corresponds to. */
  taskId: string

  /** Execution outcome. */
  status: ExecutionStatus

  /** Process exit code. Null for API-based backends. */
  exitCode: number | null

  /** Human-readable summary. */
  summary: string

  /** Files created, modified, or deleted. */
  fileChanges: FileChange[]

  /** Combined stdout. */
  stdout: string

  /** Combined stderr. */
  stderr: string

  /** Token consumption. */
  tokenUsage: TokenUsage

  /** Structured artifacts. */
  artifacts: ExecutionArtifact[]

  /** Wall-clock duration (ms). */
  durationMs: number

  /** Error details (if status is 'failed' or 'timed_out'). */
  error?: ExecutionError
}

export interface FileChange {
  /** Relative path from workspace root. */
  path: string
  operation: "created" | "modified" | "deleted"
  /** Unified diff. Null for deletions or when unavailable. */
  diff: string | null
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface ExecutionArtifact {
  type: string
  name: string
  content: string
  mimeType: string
}

export interface ExecutionError {
  message: string
  /** Maps to spike #28's ErrorClassification. */
  classification: "transient" | "permanent" | "timeout" | "resource"
  code?: string
  /** Whether the task may have produced partial side effects. */
  partialExecution: boolean
}

// ──────────────────────────────────────────────────
// Output Event Types (Streaming)
// ──────────────────────────────────────────────────

export type OutputEvent =
  | OutputTextEvent
  | OutputToolUseEvent
  | OutputToolResultEvent
  | OutputFileChangeEvent
  | OutputProgressEvent
  | OutputUsageEvent
  | OutputErrorEvent
  | OutputCompleteEvent

export interface OutputTextEvent {
  type: "text"
  timestamp: string
  content: string
}

export interface OutputToolUseEvent {
  type: "tool_use"
  timestamp: string
  toolName: string
  toolInput: Record<string, unknown>
}

export interface OutputToolResultEvent {
  type: "tool_result"
  timestamp: string
  toolName: string
  output: string
  isError: boolean
}

export interface OutputFileChangeEvent {
  type: "file_change"
  timestamp: string
  path: string
  operation: "created" | "modified" | "deleted"
}

export interface OutputProgressEvent {
  type: "progress"
  timestamp: string
  /** 0.0 to 1.0, or null if progress is indeterminate. */
  percent: number | null
  message: string
}

export interface OutputUsageEvent {
  type: "usage"
  timestamp: string
  tokenUsage: TokenUsage
}

export interface OutputErrorEvent {
  type: "error"
  timestamp: string
  message: string
  classification: "transient" | "permanent" | "timeout" | "resource"
}

export interface OutputCompleteEvent {
  type: "complete"
  timestamp: string
  result: ExecutionResult
}

// ──────────────────────────────────────────────────
// Health Check Types
// ──────────────────────────────────────────────────

export interface BackendHealthReport {
  backendId: string
  status: "healthy" | "degraded" | "unhealthy"
  reason?: string
  checkedAt: string
  latencyMs: number
  details: Record<string, unknown>
}

// ──────────────────────────────────────────────────
// Backend Interface
// ──────────────────────────────────────────────────

export interface ExecutionHandle {
  /** The task ID. */
  readonly taskId: string

  /**
   * Async iterable of output events. Yields events as they arrive.
   * Supports backpressure via for-await-of.
   */
  events(): AsyncIterable<OutputEvent>

  /**
   * Await the final result. Resolves when the task completes.
   */
  result(): Promise<ExecutionResult>

  /**
   * Cancel the running task.
   * @param reason - Human-readable cancellation reason for audit logging.
   */
  cancel(reason: string): Promise<void>
}

export interface BackendCapabilities {
  supportsStreaming: boolean
  supportsFileEdit: boolean
  supportsShellExecution: boolean
  reportsTokenUsage: boolean
  supportsCancellation: boolean
  supportedGoalTypes: TaskInstruction["goalType"][]
  maxContextTokens: number
}

export interface ExecutionBackend {
  /** Unique identifier for this backend type (e.g., 'claude-code', 'codex'). */
  readonly backendId: string

  /**
   * Initialize the backend. Called once during agent boot.
   * Throw if the backend cannot be initialized.
   */
  start(config: Record<string, unknown>): Promise<void>

  /**
   * Graceful shutdown. Kill active subprocesses, close connections.
   */
  stop(): Promise<void>

  /**
   * Check backend availability. Must complete within 5 seconds.
   * Must not throw — return unhealthy status instead.
   */
  healthCheck(): Promise<BackendHealthReport>

  /**
   * Submit a task for execution. Returns immediately with an ExecutionHandle.
   * Does NOT block until completion.
   *
   * @throws if the task cannot be started (invalid config, backend not started).
   */
  executeTask(task: ExecutionTask): Promise<ExecutionHandle>

  /** Report the backend's capabilities for feature negotiation. */
  getCapabilities(): BackendCapabilities
}
