/**
 * Antigravity Backend
 *
 * Routes google-antigravity credentials through @mariozechner/pi-ai's native
 * streaming interface (google-gemini-cli API). This isolates all Antigravity-
 * specific protocol details (endpoint fallback, token wrapping, Cloud Code
 * metadata, thinking-block sanitisation) behind pi-ai's unified event stream.
 */

import type {
  ExecutionHandle,
  ExecutionResult,
  ExecutionTask,
  OutputCompleteEvent,
  OutputEvent,
  OutputTextEvent,
  OutputToolResultEvent,
  OutputToolUseEvent,
  OutputUsageEvent,
  TokenUsage,
} from "@cortex/shared/backends"
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai"
import { getModel, streamSimple } from "@mariozechner/pi-ai"

import type { TokenRefresher } from "./http-llm.js"
import type { ToolDefinition, ToolRegistry } from "./tool-executor.js"

// ──────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────

/**
 * Antigravity endpoint candidates, tried in order (prod first, then sandbox).
 */
const ANTIGRAVITY_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

/**
 * Build the apiKey string that pi-ai's google-gemini-cli provider expects.
 * Wraps the OAuth token with the GCP project ID as a JSON blob.
 */
function buildApiKey(token: string, projectId?: string | null): string {
  if (!projectId) return token
  return JSON.stringify({ token, projectId })
}

/**
 * Resolve the base URL for the Antigravity endpoint.
 * Priority: credential.baseUrl > ANTIGRAVITY_BASE_URL env > prod endpoint.
 */
function resolveBaseUrl(credBaseUrl?: string | null): string {
  if (credBaseUrl) return credBaseUrl
  const envUrl = process.env.ANTIGRAVITY_BASE_URL
  if (envUrl) return envUrl
  return ANTIGRAVITY_ENDPOINTS[0]
}

/**
 * Return the next Antigravity endpoint to try after a failure, or null if
 * all candidates have been exhausted.
 */
function nextEndpoint(currentBaseUrl: string): string | null {
  const idx = ANTIGRAVITY_ENDPOINTS.indexOf(
    currentBaseUrl as (typeof ANTIGRAVITY_ENDPOINTS)[number],
  )
  if (idx >= 0 && idx + 1 < ANTIGRAVITY_ENDPOINTS.length) {
    return ANTIGRAVITY_ENDPOINTS[idx + 1] ?? null
  }
  return null
}

/** Returns true if the error is a 401 authentication error. */
function is401Error(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as { status: number }).status === 401
}

/**
 * Strip HTML tags and collapse whitespace from an error message.
 */
function sanitizeErrorMessage(message: string): string {
  if (!/<[a-z/][\s\S]*>/i.test(message)) return message
  return message
    .replace(/<[^>]*>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
}

/**
 * Convert Cortex conversation history turns to pi-ai Message format.
 */
function toMessages(history: Array<{ role: string; content: string }>): Message[] {
  return history.map((turn) => {
    if (turn.role === "user") {
      return {
        role: "user" as const,
        content: turn.content,
        timestamp: Date.now(),
      }
    }
    // assistant turns — pi-ai expects AssistantMessage shape
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: turn.content }],
      api: "google-gemini-cli" as Api,
      provider: "google-antigravity",
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    }
  })
}

/**
 * Convert Cortex ToolDefinitions to pi-ai Tool format.
 */
function toPiAiTools(defs: ToolDefinition[]): Tool[] {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Tool["parameters"],
  }))
}

/**
 * Map pi-ai Usage to Cortex TokenUsage.
 */
function mapUsage(piUsage: Usage): TokenUsage {
  return {
    inputTokens: piUsage.input,
    outputTokens: piUsage.output,
    costUsd: piUsage.cost.total,
    cacheReadTokens: piUsage.cacheRead,
    cacheCreationTokens: piUsage.cacheWrite,
  }
}

// ──────────────────────────────────────────────────
// Model resolution
// ──────────────────────────────────────────────────

/**
 * Resolve a pi-ai model for google-antigravity.
 * Strips date suffixes (e.g. "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5")
 * and optionally overrides the baseUrl.
 */
export function resolveAntigravityModel(modelId: string, baseUrl?: string): Model<Api> {
  // Strip date suffix (YYYYMMDD) that Anthropic model IDs carry
  const stripped = modelId.replace(/-\d{8}$/, "")

  try {
    const model = getModel("google-antigravity", stripped as never)
    if (baseUrl) {
      return { ...model, baseUrl }
    }
    return model
  } catch {
    // Unknown model — construct a fallback model descriptor
    return {
      id: stripped,
      name: stripped,
      api: "google-gemini-cli" as Api,
      provider: "google-antigravity",
      baseUrl: baseUrl ?? ANTIGRAVITY_ENDPOINTS[0],
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    } as Model<Api>
  }
}

// ──────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────

interface AntigravityOpts {
  tokenRefresher?: TokenRefresher
  credentialId?: string
}

/**
 * Create an AntigravityHandle for executing a task via pi-ai.
 */
export function createAntigravityHandle(
  task: ExecutionTask,
  model: string,
  startTime: number,
  toolRegistry: ToolRegistry,
  opts?: AntigravityOpts,
): AntigravityHandle {
  return new AntigravityHandle(task, model, startTime, toolRegistry, opts)
}

// ──────────────────────────────────────────────────
// AntigravityHandle
// ──────────────────────────────────────────────────

export class AntigravityHandle implements ExecutionHandle {
  readonly taskId: string

  /**
   * Override point for tests — replace to inject a mock stream factory.
   */
  public streamFactory: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream = streamSimple

  private cancelled = false
  private abortController = new AbortController()
  private resultPromise: Promise<ExecutionResult>
  private resolveResult!: (result: ExecutionResult) => void
  private resultResolved = false

  private readonly tokenRefresher?: TokenRefresher
  private readonly credentialId?: string

  constructor(
    private readonly task: ExecutionTask,
    private readonly modelId: string,
    private readonly startTime: number,
    private readonly toolRegistry: ToolRegistry,
    opts?: AntigravityOpts,
  ) {
    this.taskId = task.id
    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
    this.tokenRefresher = opts?.tokenRefresher
    this.credentialId = opts?.credentialId
  }

  async *events(): AsyncIterable<OutputEvent> {
    if (this.cancelled) return

    const cred = this.task.constraints.llmCredential
    if (!cred) {
      this.settleResult({
        taskId: this.taskId,
        status: "failed",
        exitCode: null,
        summary: "No LLM credential for Antigravity",
        fileChanges: [],
        stdout: "",
        stderr: "Missing google-antigravity credential",
        tokenUsage: { ...ZERO_TOKEN_USAGE },
        artifacts: [],
        durationMs: Date.now() - this.startTime,
        error: {
          message: "Missing credential",
          classification: "permanent",
          partialExecution: false,
        },
      })
      return
    }

    let baseUrl = resolveBaseUrl(cred.baseUrl)
    let apiKey = buildApiKey(cred.token, cred.accountId)

    const systemPrompt = this.task.context.systemPrompt || "You are a helpful assistant."
    const messages: Message[] = []

    // Replay conversation history
    if (this.task.instruction.conversationHistory) {
      messages.push(...toMessages(this.task.instruction.conversationHistory))
    }

    // Add the current user message
    messages.push({
      role: "user",
      content: this.task.instruction.prompt,
      timestamp: Date.now(),
    })

    // Resolve available tools
    const toolDefs = this.toolRegistry.resolve(
      this.task.constraints.allowedTools,
      this.task.constraints.deniedTools,
    )
    const piTools = toPiAiTools(toolDefs)

    let fullText = ""
    const usage: TokenUsage = { ...ZERO_TOKEN_USAGE }
    const maxTurns = Math.max(this.task.constraints.maxTurns, 1)
    let lastRetryTurn = -1

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.cancelled) break

        const model = resolveAntigravityModel(this.modelId, baseUrl)

        const context: Context = {
          systemPrompt,
          messages,
          ...(piTools.length > 0 ? { tools: piTools } : {}),
        }

        const streamOpts: SimpleStreamOptions = {
          maxTokens: Math.min(this.task.constraints.maxTokens, 8192),
          signal: this.abortController.signal,
          apiKey,
        }

        try {
          const eventStream = this.streamFactory(model, context, streamOpts)

          const toolCalls: ToolCall[] = []

          for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
            if (this.cancelled) break

            if (event.type === "text_delta") {
              fullText += event.delta
              const textEvent: OutputTextEvent = {
                type: "text",
                timestamp: new Date().toISOString(),
                content: event.delta,
              }
              yield textEvent
            }

            if (event.type === "toolcall_end") {
              toolCalls.push(event.toolCall)
            }

            // Accumulate usage from done/error events
            if (event.type === "done") {
              const piUsage = mapUsage(event.message.usage)
              usage.inputTokens += piUsage.inputTokens
              usage.outputTokens += piUsage.outputTokens
              usage.costUsd += piUsage.costUsd
              usage.cacheReadTokens += piUsage.cacheReadTokens
              usage.cacheCreationTokens += piUsage.cacheCreationTokens
            }

            if (event.type === "error") {
              const piUsage = mapUsage(event.error.usage)
              usage.inputTokens += piUsage.inputTokens
              usage.outputTokens += piUsage.outputTokens
              usage.costUsd += piUsage.costUsd
              usage.cacheReadTokens += piUsage.cacheReadTokens
              usage.cacheCreationTokens += piUsage.cacheCreationTokens

              if (event.error.errorMessage) {
                throw new Error(event.error.errorMessage)
              }
            }
          }

          // No tool calls or last turn — done
          if (toolCalls.length === 0 || turn + 1 >= maxTurns) {
            break
          }

          // Add the assistant response with tool calls to conversation
          messages.push({
            role: "assistant",
            content: toolCalls.map((tc) => ({
              type: "toolCall" as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
            api: "google-gemini-cli" as Api,
            provider: "google-antigravity",
            model: this.modelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: Date.now(),
          })

          // Execute each tool and build tool result messages
          for (const tc of toolCalls) {
            const toolUseEvent: OutputToolUseEvent = {
              type: "tool_use",
              timestamp: new Date().toISOString(),
              toolName: tc.name,
              toolInput: tc.arguments,
            }
            yield toolUseEvent

            const { output, isError } = await this.toolRegistry.execute(tc.name, tc.arguments)

            const toolResultEvent: OutputToolResultEvent = {
              type: "tool_result",
              timestamp: new Date().toISOString(),
              toolName: tc.name,
              output,
              isError,
            }
            yield toolResultEvent

            // Add tool result message for the next turn
            messages.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: output }],
              isError,
              timestamp: Date.now(),
            })
          }
        } catch (err) {
          // On 401, attempt token refresh and retry the current turn once
          if (
            is401Error(err) &&
            turn !== lastRetryTurn &&
            this.tokenRefresher &&
            this.credentialId
          ) {
            lastRetryTurn = turn
            const newToken = await this.tokenRefresher(this.credentialId)
            if (newToken) {
              apiKey = buildApiKey(newToken, cred.accountId)
              turn-- // retry this turn
              continue
            }
          }

          // Endpoint fallback: on connection failure, try next endpoint
          if (turn === 0) {
            const fallback = nextEndpoint(baseUrl)
            if (fallback) {
              baseUrl = fallback
              apiKey = buildApiKey(cred.token, cred.accountId)
              turn-- // retry this turn with fallback endpoint
              continue
            }
          }

          throw err
        }
      }

      const usageEvent: OutputUsageEvent = {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: usage,
      }
      yield usageEvent

      const execResult: ExecutionResult = {
        taskId: this.taskId,
        status: this.cancelled ? "cancelled" : "completed",
        exitCode: null,
        summary: fullText.slice(0, 200),
        fileChanges: [],
        stdout: fullText,
        stderr: "",
        tokenUsage: usage,
        artifacts: [],
        durationMs: Date.now() - this.startTime,
      }
      this.settleResult(execResult)

      const completeEvent: OutputCompleteEvent = {
        type: "complete",
        timestamp: new Date().toISOString(),
        result: execResult,
      }
      yield completeEvent
    } catch (err) {
      if (this.cancelled) return

      const rawMsg = err instanceof Error ? err.message : "Unknown error"
      const errorMsg = sanitizeErrorMessage(rawMsg)
      const execResult: ExecutionResult = {
        taskId: this.taskId,
        status: "failed",
        exitCode: null,
        summary: `Antigravity API error: ${errorMsg}`,
        fileChanges: [],
        stdout: fullText,
        stderr: errorMsg,
        tokenUsage: usage,
        artifacts: [],
        durationMs: Date.now() - this.startTime,
        error: {
          message: errorMsg,
          classification: "transient",
          partialExecution: fullText.length > 0,
        },
      }
      this.settleResult(execResult)

      const completeEvent: OutputCompleteEvent = {
        type: "complete",
        timestamp: new Date().toISOString(),
        result: execResult,
      }
      yield completeEvent
    }
  }

  async result(): Promise<ExecutionResult> {
    return this.resultPromise
  }

  cancel(reason: string): Promise<void> {
    this.cancelled = true
    this.abortController.abort()
    this.settleResult({
      taskId: this.taskId,
      status: "cancelled",
      exitCode: null,
      summary: `Cancelled: ${reason}`,
      fileChanges: [],
      stdout: "",
      stderr: "",
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      artifacts: [],
      durationMs: Date.now() - this.startTime,
    })
    return Promise.resolve()
  }

  private settleResult(result: ExecutionResult): void {
    if (!this.resultResolved) {
      this.resultResolved = true
      this.resolveResult(result)
    }
  }
}
