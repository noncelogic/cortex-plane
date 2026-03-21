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

import { getStaticModels } from "../auth/model-catalogue.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import { createAntigravityHandle } from "./antigravity-backend.js"
import {
  createAgentToolRegistry,
  createDefaultToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from "./tool-executor.js"
import type { CredentialResolver } from "./tools/webhook.js"

export interface McpDeps {
  mcpRouter?: McpToolRouter
  agentId: string
  allowedTools?: string[]
  deniedTools?: string[]
  credentialResolver?: CredentialResolver
}

/**
 * Callback for refreshing an expired OAuth token.
 * Takes the credentialId and returns a fresh access token, or null on failure.
 */
export type TokenRefresher = (credentialId: string) => Promise<string | null>

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

    // Create a global client when a global API key is available.
    // When no key is configured, the backend starts in "credential-required"
    // mode — per-job credentials from agent_credential_binding will supply
    // the key at execution time.
    if (this.apiKey) {
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

    // Credential-required mode: no global client available
    if (!this.anthropicClient && !this.openaiClient) {
      return {
        backendId: this.backendId,
        status: "healthy",
        reason: "Credential-required mode — per-job credentials will supply API keys",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        details: { provider: this.provider, model: this.model, credentialRequired: true },
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
  executeTask(
    task: ExecutionTask,
    taskToolRegistry?: ToolRegistry,
    tokenRefresher?: TokenRefresher,
  ): Promise<ExecutionHandle> {
    if (!this.started) {
      return Promise.reject(new Error("HttpLlmBackend not started"))
    }

    const startTime = Date.now()
    const registry = taskToolRegistry ?? this.toolRegistry
    const baseUrl = this.baseUrl

    // Per-job credential override: create a one-shot client with the job's token
    const cred = task.constraints.llmCredential
    const requestedModel = task.constraints.model
    const model = normalizeModelForProvider(requestedModel || this.model, cred?.provider)

    // Fail fast only for explicit per-task model overrides when provider has a
    // known static catalogue. This keeps default provider flows stable while
    // still surfacing typed model_unavailable errors for explicit invalid picks.
    if (cred && requestedModel) {
      const unavailable = buildModelUnavailableResult(task, startTime, cred.provider, model)
      if (unavailable) {
        return Promise.resolve(new FailedExecutionHandle(task.id, unavailable))
      }
    }
    if (cred) {
      // Google Antigravity routes through the pi-ai native streaming backend
      if (cred.provider === "google-antigravity") {
        return Promise.resolve(
          createAntigravityHandle(task, model, startTime, registry, {
            tokenRefresher,
            credentialId: cred.credentialId,
          }),
        )
      }

      const credProvider = mapCredentialProvider(cred.provider)
      if (credProvider === "anthropic") {
        // OAuth credentials use bearer auth tokens; API keys use x-api-key.
        const useBearer = cred.credentialType === "oauth"

        const clientBaseUrl = baseUrl

        const client = new Anthropic({
          ...(useBearer ? { authToken: cred.token, apiKey: null } : { apiKey: cred.token }),
          ...(clientBaseUrl ? { baseURL: clientBaseUrl } : {}),
        })

        return Promise.resolve(
          new AnthropicHandle(task, client, model, startTime, registry, {
            tokenRefresher,
            credentialId: cred.credentialId,
            baseUrl: clientBaseUrl,
            useAuthToken: useBearer,
          }),
        )
      }
      // OpenAI or other providers — resolve base URL from credential or provider default
      const openaiBaseUrl = cred.baseUrl ?? baseUrl ?? resolveOpenAICompatibleBaseUrl(cred.provider)
      const client = new OpenAI({
        apiKey: cred.token,
        ...(openaiBaseUrl ? { baseURL: openaiBaseUrl } : {}),
      })
      return Promise.resolve(
        new OpenAIHandle(task, client, model, startTime, registry, {
          tokenRefresher,
          credentialId: cred.credentialId,
          baseUrl: openaiBaseUrl,
        }),
      )
    }

    // Fall back to the backend's global client (env var LLM_API_KEY)
    if (this.provider === "anthropic" && this.anthropicClient) {
      return Promise.resolve(
        new AnthropicHandle(task, this.anthropicClient, model, startTime, registry),
      )
    }

    if (this.openaiClient) {
      return Promise.resolve(new OpenAIHandle(task, this.openaiClient, model, startTime, registry))
    }

    return Promise.reject(
      new Error(
        "No LLM credential available. Bind an OAuth credential to this agent " +
          "or set LLM_API_KEY env var.",
      ),
    )
  }

  /**
   * Create a per-agent ToolRegistry from the agent's config JSONB.
   * Includes all built-in tools plus any custom webhook tools defined
   * in agentConfig.tools. When mcpDeps are provided, MCP tools are
   * resolved and merged into the registry.
   */
  async createAgentRegistry(
    agentConfig: Record<string, unknown>,
    mcpDeps?: McpDeps,
  ): Promise<ToolRegistry> {
    return createAgentToolRegistry(
      agentConfig,
      mcpDeps
        ? {
            agentId: mcpDeps.agentId,
            mcpRouter: mcpDeps.mcpRouter,
            allowedTools: mcpDeps.allowedTools,
            deniedTools: mcpDeps.deniedTools,
            credentialResolver: mcpDeps.credentialResolver,
          }
        : undefined,
    )
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

/** Options for per-job token refresh (passed to Handle constructors). */
interface RefreshOpts {
  tokenRefresher?: TokenRefresher
  credentialId?: string
  baseUrl?: string
  /** When true, use Bearer auth (`authToken`) instead of `apiKey` for the Anthropic SDK. */
  useAuthToken?: boolean
}

/** Returns true if the error is a 401 authentication error from an LLM SDK. */
function is401Error(err: unknown): boolean {
  return err instanceof Error && "status" in err && (err as { status: number }).status === 401
}

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

/**
 * Map a credential provider ID to the LLM provider type.
 * Credentials from "anthropic" use the Anthropic SDK,
 * while "openai", "openai-codex", "google-ai-studio" use the OpenAI SDK.
 */
function mapCredentialProvider(provider: string): LlmProvider {
  if (provider === "anthropic") return "anthropic"
  return "openai"
}

/**
 * Return the default base URL for OpenAI-compatible providers that use
 * a non-standard endpoint. Returns undefined for native OpenAI providers.
 */
function resolveOpenAICompatibleBaseUrl(provider: string): string | undefined {
  if (provider === "google-ai-studio") {
    return "https://generativelanguage.googleapis.com/v1beta/openai/"
  }
  return undefined
}

/**
 * Strip HTML tags and collapse whitespace from an error message.
 * LLM providers sometimes return raw HTML error pages; showing those in the
 * chat UI is ugly and unhelpful.
 */
function sanitizeProviderErrorMessage(message: string): string {
  if (!/<[a-z/][\s\S]*>/i.test(message)) return message
  return message
    .replace(/<[^>]*>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
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

function normalizeModelForProvider(model: string, provider?: string): string {
  if (provider === "google-antigravity") {
    return model.replace(/-\d{8}$/, "")
  }
  return model
}

function buildModelUnavailableResult(
  task: ExecutionTask,
  startTime: number,
  provider: string,
  model: string,
): ExecutionResult | null {
  // Keep this strict validation focused to providers with stable static model IDs
  // in tests/runtime to avoid breaking legacy/default alias behavior elsewhere.
  if (provider !== "openai-codex") return null

  const staticModels = getStaticModels(provider)
  if (!staticModels || staticModels.length === 0) return null

  const available = staticModels.some((m) => m.id === model)
  if (available) return null

  const availableIds = staticModels.map((m) => m.id)
  return {
    taskId: task.id,
    status: "failed",
    exitCode: null,
    summary: `Model '${model}' is not available for provider '${provider}'`,
    fileChanges: [],
    stdout: "",
    stderr: `Requested model '${model}' is unavailable for provider '${provider}'. Available models: ${availableIds.join(", ")}`,
    tokenUsage: { ...ZERO_TOKEN_USAGE },
    artifacts: [],
    durationMs: Date.now() - startTime,
    error: {
      message: `Model '${model}' is unavailable for provider '${provider}'`,
      classification: "permanent",
      code: "model_unavailable",
      partialExecution: false,
    },
  }
}

class FailedExecutionHandle implements ExecutionHandle {
  readonly taskId: string
  constructor(
    taskId: string,
    private readonly failedResult: ExecutionResult,
  ) {
    this.taskId = taskId
  }
  async *events(): AsyncIterable<OutputEvent> {
    await Promise.resolve()
    yield { type: "complete", timestamp: new Date().toISOString(), result: this.failedResult }
  }
  result(): Promise<ExecutionResult> {
    return Promise.resolve(this.failedResult)
  }
  cancel(_reason: string): Promise<void> {
    return Promise.resolve()
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

  private readonly tokenRefresher?: TokenRefresher
  private readonly credentialId?: string
  private baseUrl?: string
  private readonly useAuthToken: boolean

  constructor(
    private readonly task: ExecutionTask,
    private client: Anthropic,
    private readonly model: string,
    private readonly startTime: number,
    private readonly toolRegistry: ToolRegistry,
    refreshOpts?: RefreshOpts,
  ) {
    this.taskId = task.id
    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
    this.tokenRefresher = refreshOpts?.tokenRefresher
    this.credentialId = refreshOpts?.credentialId
    this.baseUrl = refreshOpts?.baseUrl
    this.useAuthToken = refreshOpts?.useAuthToken ?? false
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
    let lastRetryTurn = -1

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.cancelled) break

        const streamParams = {
          model: this.model,
          max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
          system: systemPrompt,
          messages,
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        }

        try {
          const stream = this.client.messages.stream(streamParams, {
            signal: this.abortController.signal,
          })

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
              this.client = new Anthropic({
                ...(this.useAuthToken
                  ? { authToken: newToken, apiKey: null }
                  : { apiKey: newToken }),
                ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
              })
              turn-- // retry this turn
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
      const errorMsg = sanitizeProviderErrorMessage(rawMsg)
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

  private readonly tokenRefresher?: TokenRefresher
  private readonly credentialId?: string
  private readonly baseUrl?: string

  constructor(
    private readonly task: ExecutionTask,
    private client: OpenAI,
    private readonly model: string,
    private readonly startTime: number,
    private readonly toolRegistry: ToolRegistry,
    refreshOpts?: RefreshOpts,
  ) {
    this.taskId = task.id
    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
    this.tokenRefresher = refreshOpts?.tokenRefresher
    this.credentialId = refreshOpts?.credentialId
    this.baseUrl = refreshOpts?.baseUrl
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
    let lastRetryTurn = -1

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (this.cancelled) break

        const createParams = {
          model: this.model,
          max_tokens: Math.min(this.task.constraints.maxTokens, 8192),
          messages,
          stream: true as const,
          stream_options: { include_usage: true },
          ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        }

        try {
          const stream = await this.client.chat.completions.create(createParams, {
            signal: this.abortController.signal,
          })

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
              this.client = new OpenAI({
                apiKey: newToken,
                ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
              })
              turn-- // retry this turn
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
      const errorMsg = sanitizeProviderErrorMessage(rawMsg)
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
