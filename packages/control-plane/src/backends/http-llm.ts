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

import type { McpToolRouter } from "../mcp/tool-router.js"
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

    const model = task.constraints.model || this.model
    const startTime = Date.now()
    const registry = taskToolRegistry ?? this.toolRegistry
    const baseUrl = this.baseUrl

    // Per-job credential override: create a one-shot client with the job's token
    const cred = task.constraints.llmCredential
    if (cred) {
      const credProvider = mapCredentialProvider(cred.provider)
      if (credProvider === "anthropic") {
        // Google Antigravity routes through the Antigravity proxy with Bearer auth.
        const isAntigravity = cred.provider === "google-antigravity"
        // Antigravity: Bearer auth (Google Vertex AI requires it)
        // Anthropic OAuth: x-api-key header (Anthropic requires it, NOT Bearer)
        // Other OAuth: Bearer auth
        const isAnthropicOAuth = cred.provider === "anthropic" && cred.credentialType === "oauth"
        const useBearer = (cred.credentialType === "oauth" || isAntigravity) && !isAnthropicOAuth

        let client: Anthropic
        let clientBaseUrl = baseUrl

        if (isAntigravity) {
          const routing = resolveAntigravityRouting(cred.baseUrl, cred.accountId)
          clientBaseUrl = routing.baseUrl
          // Wrap token with projectId for Antigravity (OpenClaw pattern)
          const wrappedToken = wrapAntigravityToken(cred.token, cred.accountId)
          client = new Anthropic({
            authToken: wrappedToken,
            apiKey: null as unknown as string,
            baseURL: routing.baseUrl,
            fetch: createAntigravityFetch(),
          })
        } else {
          client = new Anthropic({
            ...(useBearer ? { authToken: cred.token, apiKey: null } : { apiKey: cred.token }),
            ...(clientBaseUrl ? { baseURL: clientBaseUrl } : {}),
          })
        }

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
 * Credentials from "anthropic" or "google-antigravity" use the Anthropic SDK,
 * while "openai", "openai-codex", "google-ai-studio" use the OpenAI SDK.
 */
function mapCredentialProvider(provider: string): LlmProvider {
  if (provider === "anthropic" || provider === "google-antigravity") return "anthropic"
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
 * Antigravity endpoint candidates, tried in order (prod first, then sandbox).
 * Mirrors the endpoint fallback strategy from the OpenClaw reference.
 */
const ANTIGRAVITY_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const

/**
 * Resolve Antigravity routing config.
 *
 * Priority:
 *   1. Explicit `baseUrl` on the credential ref (set by provider config) — assumed
 *      to be a custom proxy that accepts standard Anthropic API format.
 *   2. `ANTIGRAVITY_BASE_URL` env var — same assumption.
 *   3. Endpoint fallback: try prod first, then sandbox.
 *      Consumer OAuth tokens cannot access Vertex AI directly (401/403).
 */
interface AntigravityRouting {
  type: "proxy"
  baseUrl: string
}

function resolveAntigravityRouting(
  credBaseUrl?: string | null,
  _accountId?: string | null,
): AntigravityRouting {
  if (credBaseUrl) return { type: "proxy", baseUrl: credBaseUrl }

  const envUrl = process.env.ANTIGRAVITY_BASE_URL
  if (envUrl) return { type: "proxy", baseUrl: envUrl }

  // Default: production endpoint (falls back on 401/connection failure)
  return {
    type: "proxy",
    baseUrl: ANTIGRAVITY_ENDPOINTS[0],
  }
}

/**
 * Return the next Antigravity endpoint to try after a failure, or null if
 * all candidates have been exhausted.
 */
function nextAntigravityEndpoint(currentBaseUrl: string): string | null {
  const idx = ANTIGRAVITY_ENDPOINTS.indexOf(
    currentBaseUrl as (typeof ANTIGRAVITY_ENDPOINTS)[number],
  )
  if (idx >= 0 && idx + 1 < ANTIGRAVITY_ENDPOINTS.length) {
    return ANTIGRAVITY_ENDPOINTS[idx + 1] ?? null
  }
  return null
}

/**
 * Wrap an OAuth access token for Antigravity.
 *
 * The Antigravity proxy expects the auth token to be a JSON blob containing
 * both the OAuth bearer token and the GCP project ID (discovered during
 * the OAuth flow and stored as `accountId` on the credential).
 *
 * Pattern from OpenClaw's `getApiKey()`:
 *   JSON.stringify({ token: credentials.access, projectId: credentials.projectId })
 */
function wrapAntigravityToken(rawToken: string, projectId?: string | null): string {
  if (!projectId) return rawToken
  return JSON.stringify({ token: rawToken, projectId })
}

/**
 * Google Cloud Code Assist client metadata, used in Antigravity API calls.
 * Matches the metadata format used by the Cloud Code IDE plugins.
 */
const ANTIGRAVITY_CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const

/**
 * Create a custom fetch function for Google Antigravity.
 *
 * The Anthropic SDK appends `/v1/messages` to the configured baseURL,
 * but Google's Cloud Code backend serves at `/v1internal:streamCodeAssist`.
 * This fetch override intercepts outgoing requests and:
 *   1. Rewrites the URL path from `/v1/messages` to `/v1internal:streamCodeAssist`
 *   2. Adds Google-specific headers (User-Agent, X-Goog-Api-Client, Client-Metadata)
 *   3. Wraps the request body with Cloud Code metadata
 *
 * Non-messages requests pass through unchanged.
 */
export function createAntigravityFetch(): typeof globalThis.fetch {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let url: string
    let requestInit = init

    if (typeof input === "string") {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
      if (!requestInit) {
        requestInit = {
          method: input.method,
          headers: input.headers,
          body: input.body,
        }
      }
    }

    // Only intercept Anthropic SDK message endpoints
    if (!url.endsWith("/v1/messages")) {
      return globalThis.fetch(input, init)
    }

    // Rewrite path to Cloud Code Assist streaming endpoint
    const rewrittenUrl = url.replace(/\/v1\/messages$/, "/v1internal:streamCodeAssist")

    // Add Google-specific headers
    const headers = new Headers(requestInit?.headers)
    headers.set("User-Agent", "google-api-nodejs-client/9.15.1")
    headers.set("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1")
    headers.set("Client-Metadata", JSON.stringify(ANTIGRAVITY_CLIENT_METADATA))

    // Wrap request body with Cloud Code metadata
    let body = requestInit?.body
    if (body && typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        body = JSON.stringify({
          ...parsed,
          metadata: ANTIGRAVITY_CLIENT_METADATA,
        })
      } catch {
        // If body parsing fails, send as-is
      }
    }

    return globalThis.fetch(rewrittenUrl, {
      ...requestInit,
      headers,
      body,
    })
  }
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

/**
 * Sanitize thinking blocks in conversation history for Antigravity Claude.
 *
 * Antigravity Claude rejects unsigned thinking blocks. This function:
 * - Converts unsigned thinking blocks to plain text (preserving reasoning)
 * - Maps Anthropic-style `signature` field to `thinkingSignature`
 * - Validates signatures are base64-encoded
 *
 * Pattern from OpenClaw's `sanitizeAntigravityThinkingBlocks()`.
 */
const ANTIGRAVITY_SIG_RE = /^[A-Za-z0-9+/]+=*$/

function sanitizeAntigravityConversationHistory<T extends { role: string; content: string }>(
  history: T[],
  isAntigravityClaude: boolean,
): T[] {
  if (!isAntigravityClaude) return history
  return history.map((turn) => {
    if (turn.role !== "assistant") return turn

    // Try to parse content as JSON array of blocks (structured content)
    let blocks: unknown[]
    try {
      blocks = JSON.parse(turn.content) as unknown[]
      if (!Array.isArray(blocks)) return turn
    } catch {
      return turn // plain text content, no thinking blocks
    }

    let changed = false
    const sanitized = blocks
      .map((block) => {
        if (!block || typeof block !== "object") return block
        const rec = block as Record<string, unknown>
        if (rec.type !== "thinking") return block

        // Check for a valid base64 signature
        const sig = rec.thinkingSignature ?? rec.signature ?? rec.thought_signature
        if (
          typeof sig === "string" &&
          sig.length > 0 &&
          sig.length % 4 === 0 &&
          ANTIGRAVITY_SIG_RE.test(sig)
        ) {
          // Valid signature — keep thinking block, normalize field name
          if (rec.thinkingSignature !== sig) {
            changed = true
            return { ...rec, thinkingSignature: sig }
          }
          return block
        }

        // No valid signature — convert to text to preserve reasoning content
        const text = typeof rec.thinking === "string" ? rec.thinking : ""
        if (text.trim()) {
          changed = true
          return { type: "text", text }
        }
        changed = true
        return null // drop empty unsigned thinking blocks
      })
      .filter(Boolean)

    if (!changed) return turn
    return { ...turn, content: JSON.stringify(sanitized) }
  })
}

/**
 * Strip unsupported JSON Schema keywords from tool input schemas for
 * Antigravity (same restriction as google-gemini-cli — Cloud Code Assist
 * uses OpenAPI 3.03 `parameters` format for both Gemini and Claude models).
 */
const ANTIGRAVITY_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
])

function stripUnsupportedSchemaKeywords(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (ANTIGRAVITY_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue
    out[key] = value && typeof value === "object" ? stripUnsupportedSchemaKeywords(value) : value
  }
  return out
}

function sanitizeAntigravityToolSchemas(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((t) => {
    if (!t.inputSchema || typeof t.inputSchema !== "object") return t
    return {
      ...t,
      inputSchema: stripUnsupportedSchemaKeywords(t.inputSchema) as typeof t.inputSchema,
    }
  })
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

    // Detect Antigravity Claude for thinking block sanitization
    const isAntigravityClaude =
      this.task.constraints.llmCredential?.provider === "google-antigravity" &&
      this.model.toLowerCase().includes("claude")

    // Replay conversation history (sanitize thinking blocks for Antigravity Claude)
    if (this.task.instruction.conversationHistory) {
      const history = isAntigravityClaude
        ? sanitizeAntigravityConversationHistory(this.task.instruction.conversationHistory, true)
        : this.task.instruction.conversationHistory
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content })
      }
    }

    messages.push({ role: "user", content: this.task.instruction.prompt })

    // Resolve available tools based on task constraints
    let toolDefs = this.toolRegistry.resolve(
      this.task.constraints.allowedTools,
      this.task.constraints.deniedTools,
    )
    // Antigravity uses the same OpenAPI 3.03 parameters format as google-gemini-cli;
    // strip unsupported JSON Schema keywords to prevent rejection.
    if (this.task.constraints.llmCredential?.provider === "google-antigravity") {
      toolDefs = sanitizeAntigravityToolSchemas(toolDefs)
    }
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
              const isAntigravity =
                this.task.constraints.llmCredential?.provider === "google-antigravity"
              this.client = new Anthropic({
                ...(this.useAuthToken
                  ? { authToken: newToken, apiKey: null }
                  : { apiKey: newToken }),
                ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
                ...(isAntigravity ? { fetch: createAntigravityFetch() } : {}),
              })
              turn-- // retry this turn
              continue
            }
          }

          // Antigravity endpoint fallback: on connection failure, try next endpoint
          if (
            this.baseUrl &&
            this.task.constraints.llmCredential?.provider === "google-antigravity" &&
            turn === 0
          ) {
            const fallback = nextAntigravityEndpoint(this.baseUrl)
            if (fallback) {
              this.baseUrl = fallback
              const cred = this.task.constraints.llmCredential
              const wrappedToken = wrapAntigravityToken(cred.token, cred.accountId)
              this.client = new Anthropic({
                authToken: wrappedToken,
                apiKey: null as unknown as string,
                baseURL: fallback,
                fetch: createAntigravityFetch(),
              })
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
