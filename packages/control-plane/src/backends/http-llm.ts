/**
 * HTTP LLM Backend
 *
 * Calls LLM APIs directly over HTTP (Anthropic Claude or OpenAI-compatible).
 * Streams responses and emits OutputEvent events.
 */

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type {
  BackendCapabilities,
  BackendHealthReport,
  ExecutionBackend,
  ExecutionHandle,
  ExecutionResult,
  ExecutionTask,
  OutputCompleteEvent,
  OutputEvent,
  OutputTextEvent,
  OutputUsageEvent,
  TokenUsage,
} from "@cortex/shared/backends"

type LlmProvider = "anthropic" | "openai"

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export class HttpLlmBackend implements ExecutionBackend {
  readonly backendId = "http-llm"

  private provider: LlmProvider = "anthropic"
  private apiKey = ""
  private model = "claude-sonnet-4-5-20250929"
  private baseUrl: string | undefined
  private started = false

  private anthropicClient: Anthropic | null = null
  private openaiClient: OpenAI | null = null

  async start(config: Record<string, unknown>): Promise<void> {
    this.provider = (config.provider as LlmProvider) ?? process.env.LLM_PROVIDER ?? "anthropic"
    this.apiKey = (config.apiKey as string) ?? process.env.LLM_API_KEY ?? ""
    this.model = (config.model as string) ?? process.env.LLM_MODEL ?? this.defaultModel()
    this.baseUrl = (config.baseUrl as string | undefined) ?? process.env.LLM_BASE_URL

    if (!this.apiKey) {
      // Fall back to provider-specific env vars
      if (this.provider === "anthropic") {
        this.apiKey = process.env.ANTHROPIC_API_KEY ?? ""
      } else {
        this.apiKey = process.env.OPENAI_API_KEY ?? ""
      }
    }

    if (!this.apiKey) {
      throw new Error(`LLM_API_KEY (or provider-specific key) is required for http-llm backend`)
    }

    if (this.provider === "anthropic") {
      this.anthropicClient = new Anthropic({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      })
    } else {
      this.openaiClient = new OpenAI({
        apiKey: this.apiKey,
        ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
      })
    }

    this.started = true
  }

  async stop(): Promise<void> {
    this.anthropicClient = null
    this.openaiClient = null
    this.started = false
  }

  async healthCheck(): Promise<BackendHealthReport> {
    if (!this.started) {
      return {
        backendId: this.backendId,
        status: "unhealthy",
        reason: "Backend not started",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        details: {},
      }
    }

    const start = Date.now()
    try {
      if (this.provider === "anthropic" && this.anthropicClient) {
        await this.anthropicClient.messages.create({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        })
      } else if (this.openaiClient) {
        await this.openaiClient.chat.completions.create({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        })
      }
      return {
        backendId: this.backendId,
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        details: { provider: this.provider, model: this.model },
      }
    } catch (err) {
      return {
        backendId: this.backendId,
        status: "degraded",
        reason: err instanceof Error ? err.message : "Health check failed",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        details: { provider: this.provider, model: this.model },
      }
    }
  }

  async executeTask(task: ExecutionTask): Promise<ExecutionHandle> {
    if (!this.started) {
      throw new Error("HttpLlmBackend not started")
    }

    const model = task.constraints.model || this.model
    const startTime = Date.now()

    if (this.provider === "anthropic" && this.anthropicClient) {
      return new AnthropicHandle(task, this.anthropicClient, model, startTime)
    }

    if (this.openaiClient) {
      return new OpenAIHandle(task, this.openaiClient, model, startTime)
    }

    throw new Error("No LLM client initialized")
  }

  getCapabilities(): BackendCapabilities {
    return {
      supportsStreaming: true,
      supportsFileEdit: false,
      supportsShellExecution: false,
      reportsTokenUsage: true,
      supportsCancellation: true,
      supportedGoalTypes: [
        "code_edit",
        "code_generate",
        "code_review",
        "shell_command",
        "research",
      ],
      maxContextTokens: 200_000,
    }
  }

  private defaultModel(): string {
    return this.provider === "anthropic" ? "claude-sonnet-4-5-20250929" : "gpt-4o"
  }
}

// ──────────────────────────────────────────────────
// Anthropic Handle
// ──────────────────────────────────────────────────

class AnthropicHandle implements ExecutionHandle {
  readonly taskId: string

  private cancelled = false
  private abortController = new AbortController()
  private resultPromise: Promise<ExecutionResult>
  private resolveResult!: (result: ExecutionResult) => void
  private resultResolved = false

  constructor(
    private readonly task: ExecutionTask,
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly startTime: number,
  ) {
    this.taskId = task.id
    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
  }

  async *events(): AsyncIterable<OutputEvent> {
    if (this.cancelled) return

    const systemPrompt = this.task.context.systemPrompt || "You are a helpful assistant."
    const messages: Anthropic.MessageParam[] = []

    // Replay conversation history
    if (this.task.instruction.conversationHistory) {
      for (const turn of this.task.instruction.conversationHistory) {
        messages.push({ role: turn.role, content: turn.content })
      }
    }

    messages.push({ role: "user", content: this.task.instruction.prompt })

    let fullText = ""
    const usage: TokenUsage = { ...ZERO_TOKEN_USAGE }

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
          system: systemPrompt,
          messages,
        },
        { signal: this.abortController.signal },
      )

      for await (const event of stream) {
        if (this.cancelled) break

        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullText += event.delta.text
          const textEvent: OutputTextEvent = {
            type: "text",
            timestamp: new Date().toISOString(),
            content: event.delta.text,
          }
          yield textEvent
        }
      }

      const finalMessage = await stream.finalMessage()
      usage.inputTokens = finalMessage.usage.input_tokens
      usage.outputTokens = finalMessage.usage.output_tokens
      if ("cache_read_input_tokens" in finalMessage.usage) {
        usage.cacheReadTokens =
          (finalMessage.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0
      }
      if ("cache_creation_input_tokens" in finalMessage.usage) {
        usage.cacheCreationTokens =
          (finalMessage.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0
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

      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      const execResult: ExecutionResult = {
        taskId: this.taskId,
        status: "failed",
        exitCode: null,
        summary: `Anthropic API error: ${errorMsg}`,
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

  async cancel(reason: string): Promise<void> {
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
  }

  private settleResult(result: ExecutionResult): void {
    if (!this.resultResolved) {
      this.resultResolved = true
      this.resolveResult(result)
    }
  }
}

// ──────────────────────────────────────────────────
// OpenAI Handle
// ──────────────────────────────────────────────────

class OpenAIHandle implements ExecutionHandle {
  readonly taskId: string

  private cancelled = false
  private abortController = new AbortController()
  private resultPromise: Promise<ExecutionResult>
  private resolveResult!: (result: ExecutionResult) => void
  private resultResolved = false

  constructor(
    private readonly task: ExecutionTask,
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly startTime: number,
  ) {
    this.taskId = task.id
    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
  }

  async *events(): AsyncIterable<OutputEvent> {
    if (this.cancelled) return

    const systemPrompt = this.task.context.systemPrompt || "You are a helpful assistant."
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ]

    if (this.task.instruction.conversationHistory) {
      for (const turn of this.task.instruction.conversationHistory) {
        messages.push({
          role: turn.role as "user" | "assistant",
          content: turn.content,
        })
      }
    }

    messages.push({ role: "user", content: this.task.instruction.prompt })

    let fullText = ""
    const usage: TokenUsage = { ...ZERO_TOKEN_USAGE }

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: this.abortController.signal },
      )

      for await (const chunk of stream) {
        if (this.cancelled) break

        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          fullText += delta
          const textEvent: OutputTextEvent = {
            type: "text",
            timestamp: new Date().toISOString(),
            content: delta,
          }
          yield textEvent
        }

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0
          usage.outputTokens = chunk.usage.completion_tokens ?? 0
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

      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      const execResult: ExecutionResult = {
        taskId: this.taskId,
        status: "failed",
        exitCode: null,
        summary: `OpenAI API error: ${errorMsg}`,
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

  async cancel(reason: string): Promise<void> {
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
  }

  private settleResult(result: ExecutionResult): void {
    if (!this.resultResolved) {
      this.resultResolved = true
      this.resolveResult(result)
    }
  }
}
