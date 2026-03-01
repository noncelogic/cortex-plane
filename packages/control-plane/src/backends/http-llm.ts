/**
 * HTTP LLM Backend
 *
 * Calls LLM APIs directly over HTTP (Anthropic Claude or OpenAI-compatible).
 * Streams responses and emits OutputEvent events.
 *
 * Supports an agentic iteration loop: when the LLM responds with tool_use
 * blocks, the backend executes the requested tools and feeds results back
 * to the LLM, repeating until a text-only response or maxTurns is reached.
 */

import Anthropic from "@anthropic-ai/sdk"
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
  OutputToolResultEvent,
  OutputToolUseEvent,
  OutputUsageEvent,
  TokenUsage,
} from "@cortex/shared/backends"
import OpenAI from "openai"

import {
  createAgentToolRegistry,
  createDefaultToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from "./tool-executor.js"

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
  private toolRegistry: ToolRegistry

  constructor() {
    this.toolRegistry = createDefaultToolRegistry()
  }

  /** Register a custom tool for the agentic loop. */
  registerTool(tool: ToolDefinition): void {
    this.toolRegistry.register(tool)
  }

  start(config: Record<string, unknown>): Promise<void> {
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
      return Promise.reject(
        new Error(`LLM_API_KEY (or provider-specific key) is required for http-llm backend`),
      )
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
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.anthropicClient = null
    this.openaiClient = null
    this.started = false
    return Promise.resolve()
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

  /**
   * Execute a task. Accepts an optional per-task ToolRegistry that
   * includes agent-specific custom tools (e.g. webhook tools from
   * agent config). Falls back to the shared default registry.
   */
  executeTask(task: ExecutionTask, taskToolRegistry?: ToolRegistry): Promise<ExecutionHandle> {
    if (!this.started) {
      return Promise.reject(new Error("HttpLlmBackend not started"))
    }

    const model = task.constraints.model || this.model
    const startTime = Date.now()
    const registry = taskToolRegistry ?? this.toolRegistry

    if (this.provider === "anthropic" && this.anthropicClient) {
      return Promise.resolve(
        new AnthropicHandle(task, this.anthropicClient, model, startTime, registry),
      )
    }

    if (this.openaiClient) {
      return Promise.resolve(new OpenAIHandle(task, this.openaiClient, model, startTime, registry))
    }

    return Promise.reject(new Error("No LLM client initialized"))
  }

  /**
   * Create a per-agent ToolRegistry from the agent's config JSONB.
   * Includes all built-in tools plus any custom webhook tools defined
   * in agentConfig.tools.
   */
  createAgentRegistry(agentConfig: Record<string, unknown>): ToolRegistry {
    return createAgentToolRegistry(agentConfig)
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
// Helpers
// ──────────────────────────────────────────────────

function accumulateAnthropicUsage(usage: TokenUsage, raw: Anthropic.Usage): void {
  usage.inputTokens += raw.input_tokens
  usage.outputTokens += raw.output_tokens
  if ("cache_read_input_tokens" in raw) {
    usage.cacheReadTokens += (raw as unknown as Record<string, number>).cache_read_input_tokens ?? 0
  }
  if ("cache_creation_input_tokens" in raw) {
    usage.cacheCreationTokens +=
      (raw as unknown as Record<string, number>).cache_creation_input_tokens ?? 0
  }
}

function toAnthropicTools(defs: ToolDefinition[]): Anthropic.Tool[] {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))
}

function toOpenAITools(defs: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return defs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
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
    private readonly toolRegistry: ToolRegistry,
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

    // Resolve available tools based on task constraints
    const toolDefs = this.toolRegistry.resolve(
      this.task.constraints.allowedTools,
      this.task.constraints.deniedTools,
    )
    const anthropicTools = toAnthropicTools(toolDefs)

    let fullText = ""
    const usage: TokenUsage = { ...ZERO_TOKEN_USAGE }
    const maxTurns = Math.max(this.task.constraints.maxTurns, 1)

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.cancelled) break

        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
            system: systemPrompt,
            messages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
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
        accumulateAnthropicUsage(usage, finalMessage.usage)

        // Check for tool_use blocks
        const toolUseBlocks = finalMessage.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        )

        if (toolUseBlocks.length === 0 || finalMessage.stop_reason !== "tool_use") {
          break // text-only response — done
        }

        // Cannot loop again — we've used our last allowed turn
        if (turn + 1 >= maxTurns) break

        // Add the assistant response (with tool_use blocks) to the conversation
        messages.push({ role: "assistant", content: finalMessage.content })

        // Execute each tool and build tool_result blocks
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of toolUseBlocks) {
          const toolUseEvent: OutputToolUseEvent = {
            type: "tool_use",
            timestamp: new Date().toISOString(),
            toolName: block.name,
            toolInput: block.input as Record<string, unknown>,
          }
          yield toolUseEvent

          const { output, isError } = await this.toolRegistry.execute(
            block.name,
            block.input as Record<string, unknown>,
          )

          const toolResultEvent: OutputToolResultEvent = {
            type: "tool_result",
            timestamp: new Date().toISOString(),
            toolName: block.name,
            output,
            isError,
          }
          yield toolResultEvent

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
            is_error: isError,
          })
        }

        // Add tool results as the next user message
        messages.push({ role: "user", content: toolResults })
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

// ──────────────────────────────────────────────────
// OpenAI Handle
// ──────────────────────────────────────────────────

/** Accumulator for OpenAI streamed tool calls. */
interface OpenAIToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

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
    private readonly toolRegistry: ToolRegistry,
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
          role: turn.role,
          content: turn.content,
        })
      }
    }

    messages.push({ role: "user", content: this.task.instruction.prompt })

    // Resolve available tools
    const toolDefs = this.toolRegistry.resolve(
      this.task.constraints.allowedTools,
      this.task.constraints.deniedTools,
    )
    const openaiTools = toOpenAITools(toolDefs)

    let fullText = ""
    const usage: TokenUsage = { ...ZERO_TOKEN_USAGE }
    const maxTurns = Math.max(this.task.constraints.maxTurns, 1)

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.cancelled) break

        const stream = await this.client.chat.completions.create(
          {
            model: this.model,
            max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
          },
          { signal: this.abortController.signal },
        )

        let iterationText = ""
        const toolCallAccumulators = new Map<number, OpenAIToolCallAccumulator>()
        let hasToolCalls = false

        for await (const chunk of stream) {
          if (this.cancelled) break

          const choice = chunk.choices[0]

          // Accumulate text deltas
          const delta = choice?.delta?.content
          if (delta) {
            iterationText += delta
            fullText += delta
            const textEvent: OutputTextEvent = {
              type: "text",
              timestamp: new Date().toISOString(),
              content: delta,
            }
            yield textEvent
          }

          // Accumulate tool call deltas
          if (choice?.delta?.tool_calls) {
            hasToolCalls = true
            for (const tc of choice.delta.tool_calls) {
              if (!toolCallAccumulators.has(tc.index)) {
                toolCallAccumulators.set(tc.index, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  arguments: "",
                })
              }
              const acc = toolCallAccumulators.get(tc.index)!
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.arguments += tc.function.arguments
            }
          }

          if (chunk.usage) {
            usage.inputTokens += chunk.usage.prompt_tokens ?? 0
            usage.outputTokens += chunk.usage.completion_tokens ?? 0
          }
        }

        // No tool calls — done
        if (!hasToolCalls || toolCallAccumulators.size === 0) {
          break
        }

        // Cannot loop again
        if (turn + 1 >= maxTurns) break

        // Reconstruct the assistant message with tool_calls
        const toolCalls = [...toolCallAccumulators.values()]
        messages.push({
          role: "assistant",
          content: iterationText || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        })

        // Execute each tool and add results
        for (const tc of toolCalls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.arguments) as Record<string, unknown>
          } catch {
            // Malformed JSON from the model — pass empty input
          }

          const toolUseEvent: OutputToolUseEvent = {
            type: "tool_use",
            timestamp: new Date().toISOString(),
            toolName: tc.name,
            toolInput: input,
          }
          yield toolUseEvent

          const { output, isError } = await this.toolRegistry.execute(tc.name, input)

          const toolResultEvent: OutputToolResultEvent = {
            type: "tool_result",
            timestamp: new Date().toISOString(),
            toolName: tc.name,
            output,
            isError,
          }
          yield toolResultEvent

          messages.push({
            role: "tool" as const,
            tool_call_id: tc.id,
            content: output,
          })
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
