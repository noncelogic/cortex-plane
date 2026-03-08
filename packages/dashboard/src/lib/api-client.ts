/**
 * Typed REST client for the Cortex Plane Control API.
 *
 * Types mirror the OpenAPI 3.1 specification (docs/openapi.yaml).
 * Implementation is a thin wrapper around fetch() with auth headers,
 * retry logic for transient errors, and request timeouts.
 */

import { z } from "zod"

import {
  ApprovalDecisionResponseSchema,
  ArchiveContentResponseSchema,
  CreateAgentJobResponseSchema,
  PauseResponseSchema,
  PublishContentResponseSchema,
  ResumeResponseSchema,
  RetryJobResponseSchema,
  SteerResponseSchema,
  SyncMemoryResponseSchema,
} from "./schemas/actions"
import { AgentCredentialBindingListResponseSchema } from "./schemas/agent-credentials"
import { AgentDetailSchema, AgentListResponseSchema } from "./schemas/agents"
import {
  ApprovalAuditResponseSchema,
  ApprovalListResponseSchema,
  ApprovalRequestSchema,
} from "./schemas/approvals"
import {
  BrowserEventListResponseSchema,
  BrowserSessionSchema,
  CaptureScreenshotResponseSchema,
  ScreenshotListResponseSchema,
  TraceStartResponseSchema,
  TraceStateSchema,
  TraceStopResponseSchema,
} from "./schemas/browser"
import {
  ChannelConfigListResponseSchema,
  ChannelConfigResponseSchema,
} from "./schemas/channel-config"
import {
  AgentChannelBindingListResponseSchema,
  ChannelBindingsResponseSchema,
} from "./schemas/channels"
import { ContentListResponseSchema } from "./schemas/content"
import {
  CredentialListResponseSchema,
  OAuthInitResultSchema,
  ProviderListResponseSchema,
} from "./schemas/credentials"
import {
  DashboardActivitySchema,
  DashboardSummarySchema,
  JobDetailSchema,
  JobListResponseSchema,
} from "./schemas/jobs"
import {
  McpServerDetailSchema,
  McpServerListResponseSchema,
  McpServerSchema,
} from "./schemas/mcp-servers"
import { MemorySearchResponseSchema } from "./schemas/memory"
import {
  AgentCostResponseSchema,
  AgentEventListResponseSchema,
  DryRunResponseSchema,
  KillResponseSchema,
  QuarantineResponseSchema,
  ReleaseResponseSchema,
  ReplayResponseSchema,
} from "./schemas/operations"
import {
  BulkBindResponseSchema,
  CapabilityAuditResponseSchema,
  EffectiveToolsResponseSchema,
  ToolBindingListResponseSchema,
  ToolBindingSchema,
} from "./schemas/tool-bindings"

// ---------------------------------------------------------------------------
// Re-export types from schemas for backward compatibility
// ---------------------------------------------------------------------------

export type {
  AgentDetail,
  AgentLifecycleState,
  AgentStatus,
  AgentSummary,
  Checkpoint,
} from "./schemas/agents"
export type { ApprovalAuditEntry, ApprovalRequest, ApprovalStatus } from "./schemas/approvals"
export type {
  BrowserEvent,
  BrowserEventSeverity,
  BrowserEventType,
  BrowserSession,
  BrowserSessionStatus,
  BrowserTab,
  CaptureScreenshotResponse,
  Screenshot,
  TraceStartResponse,
  TraceState,
  TraceStatus,
  TraceStopResponse,
} from "./schemas/browser"
export type { Pagination } from "./schemas/common"
export type {
  ContentPiece,
  ContentPipelineStats,
  ContentStatus,
  ContentType,
} from "./schemas/content"
export type {
  FailureReason,
  JobDetail,
  JobLogEntry,
  JobMetrics,
  JobStatus,
  JobStep,
  JobSummary,
  TokenUsage,
} from "./schemas/jobs"
export type { MemoryRecord } from "./schemas/memory"
export type {
  AgentCostResponse,
  AgentEvent,
  AgentEventListResponse,
  AgentEventType,
  CostBreakdownEntry,
  CostSummary,
  DryRunResponse,
  KillResponse,
  PlannedAction,
  QuarantineResponse,
  ReleaseResponse,
  ReplayResponse,
} from "./schemas/operations"
export type {
  CapabilityAuditEntry,
  EffectiveTool,
  ToolApprovalPolicy,
  ToolBinding,
} from "./schemas/tool-bindings"

// ---------------------------------------------------------------------------
// Request types (validated by schema on response side)
// ---------------------------------------------------------------------------

export interface SteerRequest {
  message: string
  priority?: "normal" | "high"
}

/** RFC 7807 Problem Details error body. */
export interface ProblemDetail {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "CONNECTION_REFUSED"
  | "TIMEOUT"
  | "AUTH_ERROR"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "SERVER_ERROR"
  | "TRANSIENT"
  | "SCHEMA_MISMATCH"
  | "UNKNOWN"

function classifyError(status: number): ApiErrorCode {
  if (status === 401 || status === 403) return "AUTH_ERROR"
  if (status === 404) return "NOT_FOUND"
  if (status === 501) return "NOT_IMPLEMENTED"
  if (status === 503 || status === 502 || status === 504) return "TRANSIENT"
  if (status >= 500) return "SERVER_ERROR"
  return "UNKNOWN"
}

function classifyNetworkError(err: unknown): ApiErrorCode {
  const msg = err instanceof Error ? err.message.toLowerCase() : ""
  if (msg.includes("aborted") || msg.includes("timeout")) return "TIMEOUT"
  return "CONNECTION_REFUSED"
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_CORTEX_API_URL ?? "/api"

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1_000
const RETRYABLE_STATUSES = new Set([502, 503, 504])

interface FetchOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  /** Request timeout in ms (default: 10 000) */
  timeoutMs?: number
  /** Max retry attempts for transient errors (default: 2) */
  maxRetries?: number
}

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUSES.has(status)
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && err.name === "AbortError")
}

/**
 * In development, log a warning when the API response contains keys
 * that the Zod schema does not expect (would be silently stripped).
 */
function warnUnexpectedKeys(path: string, schema: z.ZodTypeAny, data: unknown): void {
  try {
    if (!data || typeof data !== "object" || Array.isArray(data)) return

    const shape = extractSchemaShape(schema)
    if (!shape) return

    const schemaKeys = new Set(Object.keys(shape))
    const dataKeys = Object.keys(data)
    const extra = dataKeys.filter((k) => !schemaKeys.has(k))

    if (extra.length > 0) {
      console.warn(`[api-client] ${path}: API response has keys not in schema: ${extra.join(", ")}`)
    }
  } catch {
    // Never break production over a dev warning
  }
}

/** Walk through schema wrappers (transforms, refinements) to find the object shape. */
function extractSchemaShape(schema: z.ZodTypeAny): Record<string, unknown> | null {
  // z.object() exposes a .shape property
  if ("shape" in schema && schema.shape && typeof schema.shape === "object") {
    return schema.shape as Record<string, unknown>
  }
  // Wrapped schemas (.transform(), .refine()) store the inner schema in _def
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def
  if (def && typeof def === "object" && "schema" in def && def.schema) {
    return extractSchemaShape(def.schema as z.ZodTypeAny)
  }
  return null
}

async function apiFetch<T>(
  path: string,
  options: FetchOptions & { schema?: z.ZodType<T> } = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    signal: externalSignal,
    schema,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = MAX_RETRIES,
  } = options

  const headers: Record<string, string> = {}
  if (body) {
    headers["Content-Type"] = "application/json"
  }

  // Session-based CSRF token (stored by auth flow)
  const csrf = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("cortex_csrf") : null
  if (csrf) {
    headers["x-csrf-token"] = csrf
  }

  // API key auth fallback
  const apiKey = process.env.NEXT_PUBLIC_CORTEX_API_KEY
  if (apiKey) {
    headers["X-API-Key"] = apiKey
  }

  let lastError: unknown = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Combine external signal with timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    if (externalSignal?.aborted) {
      clearTimeout(timeoutId)
      throw new ApiError(0, "Request aborted", undefined, "TIMEOUT")
    }

    // Abort our controller if the external signal fires
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: "include",
      })

      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)

      if (!res.ok) {
        const errorBody: unknown = await res.json().catch(() => null)
        const code = classifyError(res.status)

        // Parse as RFC 7807 ProblemDetail if possible
        if (errorBody && typeof errorBody === "object" && "type" in errorBody) {
          const problem = errorBody as ProblemDetail
          const err = new ApiError(
            res.status,
            problem.detail ?? problem.title ?? res.statusText,
            problem,
            code,
          )
          if (isRetryable(res.status) && attempt < maxRetries) {
            lastError = err
            await delay(RETRY_DELAY_MS * (attempt + 1))
            continue
          }
          throw err
        }

        const detail =
          (errorBody as Record<string, string> | null)?.detail ??
          (errorBody as Record<string, string> | null)?.message ??
          res.statusText
        const err = new ApiError(res.status, detail, undefined, code)
        if (isRetryable(res.status) && attempt < maxRetries) {
          lastError = err
          await delay(RETRY_DELAY_MS * (attempt + 1))
          continue
        }
        throw err
      }

      const data: unknown = await res.json()

      // In development, warn about unexpected keys the schema will strip
      if (process.env.NODE_ENV === "development" && schema && data && typeof data === "object") {
        warnUnexpectedKeys(path, schema, data)
      }

      return schema ? schema.parse(data) : (data as T)
    } catch (err) {
      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)

      if (err instanceof ApiError) throw err

      // Schema validation errors (e.g. ZodError) mean the API responded
      // successfully but with an unexpected shape — not a connectivity issue.
      if (err instanceof Error && err.name === "ZodError") {
        const zodMessage =
          process.env.NODE_ENV === "development"
            ? `Schema mismatch on ${method} ${path}: ${err.message}`
            : `Unexpected response format from the control plane (${method} ${path})`
        throw new ApiError(0, zodMessage, undefined, "SCHEMA_MISMATCH")
      }

      // Network errors and timeouts are retryable
      if (isNetworkError(err) && attempt < maxRetries) {
        lastError = err
        await delay(RETRY_DELAY_MS * (attempt + 1))
        continue
      }

      const code = classifyNetworkError(err)
      throw new ApiError(
        0,
        code === "TIMEOUT" ? "Request timed out" : "Could not connect to the control plane",
        undefined,
        code,
      )
    }
  }

  // All retries exhausted — throw the last error
  if (lastError instanceof ApiError) throw lastError
  const code = classifyNetworkError(lastError)
  throw new ApiError(
    0,
    code === "TIMEOUT" ? "Request timed out" : "Could not connect to the control plane",
    undefined,
    code,
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ApiError extends Error {
  public readonly problem?: ProblemDetail
  public readonly code: ApiErrorCode

  constructor(
    public status: number,
    message: string,
    problem?: ProblemDetail,
    code?: ApiErrorCode,
  ) {
    super(message)
    this.name = "ApiError"
    this.problem = problem
    this.code = code ?? classifyError(status)
  }

  get isAuth(): boolean {
    return this.code === "AUTH_ERROR"
  }

  get isConnectionError(): boolean {
    return this.code === "CONNECTION_REFUSED" || this.code === "TIMEOUT"
  }

  get isTransient(): boolean {
    return this.code === "TRANSIENT"
  }

  /** True when the endpoint doesn't exist or is not yet implemented. */
  get isFeatureUnavailable(): boolean {
    return this.code === "NOT_FOUND" || this.code === "NOT_IMPLEMENTED"
  }
}

// ---------------------------------------------------------------------------
// Typed endpoint functions
// ---------------------------------------------------------------------------

export async function listAgents(params?: {
  status?: string
  lifecycle_state?: string
  limit?: number
  offset?: number
}): Promise<{
  agents: import("./schemas/agents").AgentSummary[]
  pagination: import("./schemas/common").Pagination
}> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.lifecycle_state) search.set("lifecycle_state", params.lifecycle_state)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents${qs ? `?${qs}` : ""}`, { schema: AgentListResponseSchema })
}

export async function getAgent(agentId: string): Promise<import("./schemas/agents").AgentDetail> {
  return apiFetch(`/agents/${agentId}`, { schema: AgentDetailSchema })
}

export interface CreateAgentRequest {
  name: string
  role: string
  slug?: string
  description?: string
  model_config?: Record<string, unknown>
  skill_config?: Record<string, unknown>
  resource_limits?: Record<string, unknown>
  channel_permissions?: Record<string, unknown>
  config?: Record<string, unknown>
}

export interface UpdateAgentRequest {
  name?: string
  role?: string
  description?: string | null
  model_config?: Record<string, unknown>
  skill_config?: Record<string, unknown>
  resource_limits?: Record<string, unknown>
  channel_permissions?: Record<string, unknown>
  config?: Record<string, unknown>
  status?: "ACTIVE" | "DISABLED" | "ARCHIVED"
}

export interface CreateAgentJobRequest {
  prompt: string
  goal_type?: string
  model?: string
  priority?: number
  timeout_seconds?: number
  max_attempts?: number
  payload?: Record<string, unknown>
}

export async function createAgent(body: CreateAgentRequest): Promise<unknown> {
  return apiFetch("/agents", { method: "POST", body, schema: z.unknown() })
}

export async function updateAgent(agentId: string, body: UpdateAgentRequest): Promise<unknown> {
  return apiFetch(`/agents/${agentId}`, { method: "PUT", body, schema: z.unknown() })
}

export async function deleteAgent(agentId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}`, { method: "DELETE", schema: z.unknown() })
}

export async function createAgentJob(
  agentId: string,
  body: CreateAgentJobRequest,
): Promise<import("./schemas/actions").CreateAgentJobResponse> {
  return apiFetch(`/agents/${agentId}/jobs`, {
    method: "POST",
    body,
    schema: CreateAgentJobResponseSchema,
  })
}

export async function steerAgent(agentId: string, request: SteerRequest) {
  return apiFetch(`/agents/${agentId}/steer`, {
    method: "POST",
    body: request,
    schema: SteerResponseSchema,
  })
}

export async function pauseAgent(
  agentId: string,
  options?: { reason?: string; timeoutSeconds?: number },
) {
  return apiFetch(`/agents/${agentId}/pause`, {
    method: "POST",
    body: options,
    schema: PauseResponseSchema,
  })
}

export async function resumeAgent(
  agentId: string,
  options?: { checkpointId?: string; instruction?: string },
) {
  return apiFetch(`/agents/${agentId}/resume`, {
    method: "POST",
    body: options,
    schema: ResumeResponseSchema,
  })
}

export async function listApprovals(params?: {
  status?: string
  job_id?: string
  limit?: number
  offset?: number
}): Promise<{
  approvals: import("./schemas/approvals").ApprovalRequest[]
  pagination?: import("./schemas/common").Pagination
}> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.job_id) search.set("jobId", params.job_id)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/approvals${qs ? `?${qs}` : ""}`, { schema: ApprovalListResponseSchema })
}

export async function approveRequest(
  approvalId: string,
  decision: "APPROVED" | "REJECTED",
  decidedBy: string,
  reason?: string,
) {
  return apiFetch(`/approval/${approvalId}/decide`, {
    method: "POST",
    body: { decision, decided_by: decidedBy, channel: "dashboard", reason },
    schema: ApprovalDecisionResponseSchema,
  })
}

export async function getApprovalDetail(
  approvalId: string,
): Promise<import("./schemas/approvals").ApprovalRequest> {
  return apiFetch(`/approvals/${approvalId}`, { schema: ApprovalRequestSchema })
}

export async function getApprovalAudit(
  approvalId: string,
): Promise<{ audit: import("./schemas/approvals").ApprovalAuditEntry[] }> {
  return apiFetch(`/approvals/${approvalId}/audit`, { schema: ApprovalAuditResponseSchema })
}

export async function listJobs(params?: {
  agent_id?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<{
  jobs: import("./schemas/jobs").JobSummary[]
  pagination: import("./schemas/common").Pagination
}> {
  const search = new URLSearchParams()
  if (params?.agent_id) search.set("agentId", params.agent_id)
  if (params?.status) search.set("status", params.status)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/jobs${qs ? `?${qs}` : ""}`, { schema: JobListResponseSchema })
}

export async function getJob(jobId: string): Promise<import("./schemas/jobs").JobDetail> {
  return apiFetch(`/jobs/${jobId}`, { schema: JobDetailSchema })
}

export async function retryJob(jobId: string) {
  return apiFetch(`/jobs/${jobId}/retry`, {
    method: "POST",
    schema: RetryJobResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Dashboard aggregation endpoints
// ---------------------------------------------------------------------------

export async function getDashboardSummary(): Promise<import("./schemas/jobs").DashboardSummary> {
  return apiFetch("/dashboard/summary", { schema: DashboardSummarySchema })
}

export async function getDashboardActivity(params?: {
  limit?: number
}): Promise<import("./schemas/jobs").DashboardActivity> {
  const search = new URLSearchParams()
  if (params?.limit) search.set("limit", String(params.limit))
  const qs = search.toString()
  return apiFetch(`/dashboard/activity${qs ? `?${qs}` : ""}`, {
    schema: DashboardActivitySchema,
  })
}

// ---------------------------------------------------------------------------
// Memory endpoint functions
// ---------------------------------------------------------------------------

export async function searchMemory(params: {
  agent_id: string
  query: string
  limit?: number
}): Promise<{ results: import("./schemas/memory").MemoryRecord[] }> {
  const search = new URLSearchParams()
  search.set("agentId", params.agent_id)
  search.set("query", params.query)
  if (params.limit) search.set("limit", String(params.limit))
  return apiFetch(`/memory/search?${search.toString()}`, { schema: MemorySearchResponseSchema })
}

export async function syncMemory(
  agentId: string,
  direction?: "file_to_qdrant" | "qdrant_to_file" | "bidirectional",
) {
  return apiFetch("/memory/sync", {
    method: "POST",
    body: { agent_id: agentId, direction },
    schema: SyncMemoryResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Content pipeline endpoint functions
// ---------------------------------------------------------------------------

export async function listContent(params?: {
  status?: string
  type?: string
  agent_id?: string
  limit?: number
  offset?: number
}): Promise<{
  content: import("./schemas/content").ContentPiece[]
  pagination: import("./schemas/common").Pagination
}> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.type) search.set("type", params.type)
  if (params?.agent_id) search.set("agentId", params.agent_id)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/content${qs ? `?${qs}` : ""}`, { schema: ContentListResponseSchema })
}

export async function publishContent(contentId: string, channel: string) {
  return apiFetch(`/content/${contentId}/publish`, {
    method: "POST",
    body: { channel },
    schema: PublishContentResponseSchema,
  })
}

export async function archiveContent(contentId: string) {
  return apiFetch(`/content/${contentId}/archive`, {
    method: "POST",
    schema: ArchiveContentResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Browser observation endpoint functions
// ---------------------------------------------------------------------------

export async function getAgentBrowser(
  agentId: string,
): Promise<import("./schemas/browser").BrowserSession> {
  return apiFetch(`/agents/${agentId}/browser`, { schema: BrowserSessionSchema })
}

export async function getAgentScreenshots(agentId: string, limit?: number) {
  const search = new URLSearchParams()
  if (limit) search.set("limit", String(limit))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/browser/screenshots${qs ? `?${qs}` : ""}`, {
    schema: ScreenshotListResponseSchema,
  })
}

export async function getAgentBrowserEvents(agentId: string, limit?: number, types?: string[]) {
  const search = new URLSearchParams()
  if (limit) search.set("limit", String(limit))
  if (types?.length) search.set("types", types.join(","))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/browser/events${qs ? `?${qs}` : ""}`, {
    schema: BrowserEventListResponseSchema,
  })
}

export async function captureScreenshot(
  agentId: string,
  options?: { format?: string; quality?: number; fullPage?: boolean },
): Promise<import("./schemas/browser").CaptureScreenshotResponse> {
  return apiFetch(`/agents/${agentId}/observe/screenshot`, {
    method: "POST",
    body: options,
    schema: CaptureScreenshotResponseSchema,
  })
}

export async function getTraceState(
  agentId: string,
): Promise<import("./schemas/browser").TraceState> {
  return apiFetch(`/agents/${agentId}/observe/trace`, { schema: TraceStateSchema })
}

export async function startTrace(
  agentId: string,
  options?: { snapshots?: boolean; screenshots?: boolean; network?: boolean; console?: boolean },
): Promise<import("./schemas/browser").TraceStartResponse> {
  return apiFetch(`/agents/${agentId}/observe/trace/start`, {
    method: "POST",
    body: options,
    schema: TraceStartResponseSchema,
  })
}

export async function stopTrace(
  agentId: string,
): Promise<import("./schemas/browser").TraceStopResponse> {
  return apiFetch(`/agents/${agentId}/observe/trace/stop`, {
    method: "POST",
    schema: TraceStopResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Credential & provider-connect endpoint functions
// ---------------------------------------------------------------------------

export type { Credential, OAuthInitResult, ProviderInfo } from "./schemas/credentials"

export async function listProviders(): Promise<{
  providers: import("./schemas/credentials").ProviderInfo[]
}> {
  return apiFetch("/credentials/providers", { schema: ProviderListResponseSchema })
}

export async function listCredentials(): Promise<{
  credentials: import("./schemas/credentials").Credential[]
}> {
  return apiFetch("/credentials", { schema: CredentialListResponseSchema })
}

export async function initOAuthConnect(
  provider: string,
): Promise<import("./schemas/credentials").OAuthInitResult> {
  return apiFetch(`/auth/connect/${provider}/init`, { schema: OAuthInitResultSchema })
}

export async function exchangeOAuthConnect(
  provider: string,
  body: { pastedUrl: string; codeVerifier: string; state: string },
): Promise<unknown> {
  return apiFetch(`/auth/connect/${provider}/exchange`, {
    method: "POST",
    body,
    schema: z.unknown(),
  })
}

export async function saveProviderApiKey(body: {
  provider: string
  apiKey: string
  displayLabel?: string
}): Promise<unknown> {
  return apiFetch("/credentials/api-key", { method: "POST", body, schema: z.unknown() })
}

export async function deleteCredential(id: string): Promise<unknown> {
  return apiFetch(`/credentials/${id}`, { method: "DELETE", schema: z.unknown() })
}

// ---------------------------------------------------------------------------
// Agent channel binding endpoint functions
// ---------------------------------------------------------------------------

export type { AgentChannelBinding, BindingWithAgent } from "./schemas/channels"

export async function listAgentChannels(agentId: string): Promise<{
  bindings: import("./schemas/channels").AgentChannelBinding[]
}> {
  return apiFetch(`/agents/${agentId}/channels`, {
    schema: AgentChannelBindingListResponseSchema,
  })
}

export async function bindAgentChannel(
  agentId: string,
  channelType: string,
  chatId: string,
): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/channels`, {
    method: "POST",
    body: { channel_type: channelType, chat_id: chatId },
    schema: z.unknown(),
  })
}

export async function unbindAgentChannel(agentId: string, bindingId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/channels/${bindingId}`, {
    method: "DELETE",
    schema: z.unknown(),
  })
}

export async function listChannelBindings(channelId: string): Promise<{
  bindings: import("./schemas/channels").BindingWithAgent[]
}> {
  return apiFetch(`/channels/${channelId}/bindings`, {
    schema: ChannelBindingsResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Agent credential binding endpoint functions
// ---------------------------------------------------------------------------

export type { AgentCredentialBinding } from "./schemas/agent-credentials"

export async function listAgentCredentials(agentId: string): Promise<{
  bindings: import("./schemas/agent-credentials").AgentCredentialBinding[]
}> {
  return apiFetch(`/agents/${agentId}/credentials`, {
    schema: AgentCredentialBindingListResponseSchema,
  })
}

export async function bindAgentCredential(agentId: string, credentialId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/credentials`, {
    method: "POST",
    body: { credentialId },
    schema: z.unknown(),
  })
}

export async function unbindAgentCredential(
  agentId: string,
  credentialId: string,
): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/credentials/${credentialId}`, {
    method: "DELETE",
    schema: z.unknown(),
  })
}

// ---------------------------------------------------------------------------
// MCP server endpoint functions
// ---------------------------------------------------------------------------

export type {
  McpServer,
  McpServerDetail,
  McpServerStatus,
  McpServerTool,
  McpTransport,
} from "./schemas/mcp-servers"

export interface CreateMcpServerRequest {
  name: string
  slug?: string
  transport: "streamable-http" | "stdio"
  connection: Record<string, unknown>
  agent_scope?: string[]
  description?: string
  health_probe_interval_ms?: number
}

export async function listMcpServers(params?: {
  status?: string
  limit?: number
  offset?: number
}): Promise<{
  servers: import("./schemas/mcp-servers").McpServer[]
  pagination: import("./schemas/common").Pagination
}> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/mcp-servers${qs ? `?${qs}` : ""}`, { schema: McpServerListResponseSchema })
}

export async function getMcpServer(
  id: string,
): Promise<import("./schemas/mcp-servers").McpServerDetail> {
  return apiFetch(`/mcp-servers/${id}`, { schema: McpServerDetailSchema })
}

export async function createMcpServer(body: CreateMcpServerRequest): Promise<unknown> {
  return apiFetch("/mcp-servers", { method: "POST", body, schema: McpServerSchema })
}

export async function updateMcpServer(
  id: string,
  body: Partial<CreateMcpServerRequest> & { status?: string },
): Promise<unknown> {
  return apiFetch(`/mcp-servers/${id}`, { method: "PUT", body, schema: McpServerSchema })
}

export async function deleteMcpServer(id: string): Promise<unknown> {
  return apiFetch(`/mcp-servers/${id}`, { method: "DELETE", schema: z.unknown() })
}

export async function refreshMcpServer(id: string): Promise<unknown> {
  return apiFetch(`/mcp-servers/${id}/refresh`, { method: "POST", schema: McpServerSchema })
}

// ---------------------------------------------------------------------------
// User endpoint functions
// ---------------------------------------------------------------------------

export type { ChannelMapping, UserAccount, UserGrant, UserUsageLedger } from "./schemas/users"

import {
  AccessRequestListResponseSchema,
  CreateGrantResponseSchema,
  GeneratePairingCodeResponseSchema,
  GrantListResponseSchema,
  PairingCodeListResponseSchema,
  PendingCountResponseSchema,
  UserDetailResponseSchema,
  UserUsageResponseSchema,
} from "./schemas/users"

export type { AccessRequest, PairingCode } from "./schemas/users"

export async function getUser(
  userId: string,
): Promise<import("./schemas/users").UserDetailResponse> {
  return apiFetch(`/users/${userId}`, { schema: UserDetailResponseSchema })
}

export async function getUserUsage(
  userId: string,
  params?: { range?: "24h" | "7d" | "30d" },
): Promise<import("./schemas/users").UserUsageResponse> {
  const search = new URLSearchParams()
  if (params?.range) search.set("range", params.range)
  const qs = search.toString()
  return apiFetch(`/users/${userId}/usage${qs ? `?${qs}` : ""}`, {
    schema: UserUsageResponseSchema,
  })
}

export async function revokeUserGrant(agentId: string, grantId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/users/${grantId}`, {
    method: "DELETE",
    schema: z.unknown(),
  })
}

export async function listAgentUsers(
  agentId: string,
  params?: { limit?: number; offset?: number },
): Promise<import("./schemas/users").GrantListResponse> {
  const search = new URLSearchParams()
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/users${qs ? `?${qs}` : ""}`, {
    schema: GrantListResponseSchema,
  })
}

export async function createAgentUserGrant(
  agentId: string,
  body: {
    user_account_id: string
    access_level?: "read" | "write"
  },
): Promise<import("./schemas/users").CreateGrantResponse> {
  return apiFetch(`/agents/${agentId}/users`, {
    method: "POST",
    body,
    schema: CreateGrantResponseSchema,
  })
}

export async function generatePairingCode(
  agentId: string,
): Promise<import("./schemas/users").GeneratePairingCodeResponse> {
  return apiFetch(`/agents/${agentId}/pairing-codes`, {
    method: "POST",
    schema: GeneratePairingCodeResponseSchema,
  })
}

export async function listPairingCodes(
  agentId: string,
): Promise<import("./schemas/users").PairingCodeListResponse> {
  return apiFetch(`/agents/${agentId}/pairing-codes`, {
    schema: PairingCodeListResponseSchema,
  })
}

export async function revokePairingCode(agentId: string, codeId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/pairing-codes/${codeId}`, {
    method: "DELETE",
    schema: z.unknown(),
  })
}

export async function listAccessRequests(
  agentId: string,
  params?: { status?: string; limit?: number; offset?: number },
): Promise<import("./schemas/users").AccessRequestListResponse> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/access-requests${qs ? `?${qs}` : ""}`, {
    schema: AccessRequestListResponseSchema,
  })
}

export async function resolveAccessRequest(
  agentId: string,
  requestId: string,
  body: { status: "approved" | "denied"; deny_reason?: string },
): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/access-requests/${requestId}`, {
    method: "PATCH",
    body,
    schema: z.unknown(),
  })
}

export async function getPendingCounts(): Promise<import("./schemas/users").PendingCountResponse> {
  return apiFetch(`/access-requests/pending-count`, {
    schema: PendingCountResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Chat & session endpoint functions
// ---------------------------------------------------------------------------

import {
  ChatResponseSchema,
  MessageListResponseSchema,
  SessionDeleteResponseSchema,
  SessionListResponseSchema,
} from "./schemas/chat"

export type { ChatResponse, Session, SessionMessage } from "./schemas/chat"

export async function listAgentSessions(
  agentId: string,
  params?: { limit?: number; offset?: number },
): Promise<{
  sessions: import("./schemas/chat").Session[]
  count: number
}> {
  const search = new URLSearchParams()
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/sessions${qs ? `?${qs}` : ""}`, {
    schema: SessionListResponseSchema,
  })
}

export async function getSessionMessages(
  sessionId: string,
  params?: { limit?: number; offset?: number },
): Promise<{
  messages: import("./schemas/chat").SessionMessage[]
  count: number
}> {
  const search = new URLSearchParams()
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`, {
    schema: MessageListResponseSchema,
  })
}

export async function sendChatMessage(
  agentId: string,
  body: { text: string; session_id?: string },
  opts?: { wait?: boolean; timeout?: number },
): Promise<import("./schemas/chat").ChatResponse> {
  const search = new URLSearchParams()
  if (opts?.wait) search.set("wait", "true")
  if (opts?.timeout) search.set("timeout", String(opts.timeout))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/chat${qs ? `?${qs}` : ""}`, {
    method: "POST",
    body,
    schema: ChatResponseSchema,
    timeoutMs: (opts?.timeout ?? 60_000) + 5_000, // extra buffer beyond server timeout
  })
}

export async function deleteSession(sessionId: string): Promise<{ id: string; status: "ended" }> {
  return apiFetch(`/sessions/${sessionId}`, {
    method: "DELETE",
    schema: SessionDeleteResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Operations: events, cost, control
// ---------------------------------------------------------------------------

export async function getAgentEvents(
  agentId: string,
  params?: {
    eventTypes?: string
    since?: string
    until?: string
    limit?: number
    offset?: number
  },
): Promise<import("./schemas/operations").AgentEventListResponse> {
  const search = new URLSearchParams()
  if (params?.eventTypes) search.set("eventTypes", params.eventTypes)
  if (params?.since) search.set("since", params.since)
  if (params?.until) search.set("until", params.until)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/events${qs ? `?${qs}` : ""}`, {
    schema: AgentEventListResponseSchema,
  })
}

export async function getAgentCost(
  agentId: string,
  params?: { since?: string; until?: string; groupBy?: "model" | "session" | "day" },
): Promise<import("./schemas/operations").AgentCostResponse> {
  const search = new URLSearchParams()
  if (params?.since) search.set("since", params.since)
  if (params?.until) search.set("until", params.until)
  if (params?.groupBy) search.set("groupBy", params.groupBy)
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/cost${qs ? `?${qs}` : ""}`, {
    schema: AgentCostResponseSchema,
  })
}

export async function killAgent(
  agentId: string,
  reason: string,
): Promise<import("./schemas/operations").KillResponse> {
  return apiFetch(`/agents/${agentId}/kill`, {
    method: "POST",
    body: { reason },
    schema: KillResponseSchema,
  })
}

export async function dryRunAgent(
  agentId: string,
  message: string,
  sessionId?: string,
): Promise<import("./schemas/operations").DryRunResponse> {
  return apiFetch(`/agents/${agentId}/dry-run`, {
    method: "POST",
    body: { message, ...(sessionId ? { sessionId } : {}) },
    schema: DryRunResponseSchema,
  })
}

export async function replayAgent(
  agentId: string,
  checkpointId: string,
  modifications?: {
    model?: string
    systemPromptAppend?: string
    resourceLimits?: Record<string, unknown>
  },
): Promise<import("./schemas/operations").ReplayResponse> {
  return apiFetch(`/agents/${agentId}/replay`, {
    method: "POST",
    body: { checkpointId, ...(modifications ? { modifications } : {}) },
    schema: ReplayResponseSchema,
  })
}

export async function quarantineAgent(
  agentId: string,
  reason: string,
): Promise<import("./schemas/operations").QuarantineResponse> {
  return apiFetch(`/agents/${agentId}/quarantine`, {
    method: "POST",
    body: { reason },
    schema: QuarantineResponseSchema,
  })
}

export async function releaseAgent(
  agentId: string,
  resetCircuitBreaker?: boolean,
): Promise<import("./schemas/operations").ReleaseResponse> {
  return apiFetch(`/agents/${agentId}/release`, {
    method: "POST",
    body: { ...(resetCircuitBreaker != null ? { resetCircuitBreaker } : {}) },
    schema: ReleaseResponseSchema,
  })
}

// ---------------------------------------------------------------------------
// Channel configuration endpoint functions
// ---------------------------------------------------------------------------

export type { ChannelConfigSummary } from "./schemas/channel-config"

export async function listChannelConfigs(): Promise<{
  channels: import("./schemas/channel-config").ChannelConfigSummary[]
}> {
  return apiFetch("/channels", { schema: ChannelConfigListResponseSchema })
}

export async function getChannelConfig(
  id: string,
): Promise<{ channel: import("./schemas/channel-config").ChannelConfigSummary }> {
  return apiFetch(`/channels/${id}`, { schema: ChannelConfigResponseSchema })
}

export async function createChannelConfig(body: {
  type: string
  name: string
  config: Record<string, unknown>
}): Promise<{ channel: import("./schemas/channel-config").ChannelConfigSummary }> {
  return apiFetch("/channels", {
    method: "POST",
    body,
    schema: ChannelConfigResponseSchema,
  })
}

export async function updateChannelConfig(
  id: string,
  body: {
    name?: string
    config?: Record<string, unknown>
    enabled?: boolean
  },
): Promise<{ channel: import("./schemas/channel-config").ChannelConfigSummary }> {
  return apiFetch(`/channels/${id}`, {
    method: "PUT",
    body,
    schema: ChannelConfigResponseSchema,
  })
}

export async function deleteChannelConfig(
  id: string,
  options?: { force?: boolean },
): Promise<unknown> {
  const query = options?.force ? "?force=true" : ""
  return apiFetch(`/channels/${id}${query}`, { method: "DELETE", schema: z.unknown() })
}

// ---------------------------------------------------------------------------
// Tool Bindings
// ---------------------------------------------------------------------------

export async function listToolBindings(
  agentId: string,
  params?: { enabled?: boolean; category?: string; limit?: number; offset?: number },
): Promise<{
  bindings: import("./schemas/tool-bindings").ToolBinding[]
  total: number
}> {
  const search = new URLSearchParams()
  if (params?.enabled !== undefined) search.set("enabled", String(params.enabled))
  if (params?.category) search.set("category", params.category)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/tool-bindings${qs ? `?${qs}` : ""}`, {
    schema: ToolBindingListResponseSchema,
  })
}

export async function createToolBinding(
  agentId: string,
  body: {
    toolRef: string
    approvalPolicy?: import("./schemas/tool-bindings").ToolApprovalPolicy
    rateLimit?: Record<string, unknown> | null
    dataScope?: Record<string, unknown> | null
  },
): Promise<import("./schemas/tool-bindings").ToolBinding> {
  return apiFetch(`/agents/${agentId}/tool-bindings`, {
    method: "POST",
    body,
    schema: ToolBindingSchema,
  })
}

export async function updateToolBinding(
  agentId: string,
  bindingId: string,
  body: {
    approvalPolicy?: import("./schemas/tool-bindings").ToolApprovalPolicy
    rateLimit?: Record<string, unknown> | null
    dataScope?: Record<string, unknown> | null
    enabled?: boolean
  },
): Promise<import("./schemas/tool-bindings").ToolBinding> {
  return apiFetch(`/agents/${agentId}/tool-bindings/${bindingId}`, {
    method: "PUT",
    body,
    schema: ToolBindingSchema,
  })
}

export async function deleteToolBinding(agentId: string, bindingId: string): Promise<unknown> {
  return apiFetch(`/agents/${agentId}/tool-bindings/${bindingId}`, {
    method: "DELETE",
    schema: z.unknown(),
  })
}

export async function bulkBindTools(
  agentId: string,
  body: {
    mcpServerId: string
    toolRefs?: string[]
    approvalPolicy?: import("./schemas/tool-bindings").ToolApprovalPolicy
  },
): Promise<import("zod").infer<typeof BulkBindResponseSchema>> {
  return apiFetch(`/agents/${agentId}/tool-bindings/bulk`, {
    method: "POST",
    body,
    schema: BulkBindResponseSchema,
  })
}

export async function getEffectiveTools(agentId: string): Promise<{
  tools: import("./schemas/tool-bindings").EffectiveTool[]
  assembledAt: string
}> {
  return apiFetch(`/agents/${agentId}/effective-tools`, {
    schema: EffectiveToolsResponseSchema,
  })
}

export async function getCapabilityAudit(
  agentId: string,
  params?: { toolRef?: string; eventType?: string; limit?: number; offset?: number },
): Promise<{
  entries: import("./schemas/tool-bindings").CapabilityAuditEntry[]
  total: number
}> {
  const search = new URLSearchParams()
  if (params?.toolRef) search.set("toolRef", params.toolRef)
  if (params?.eventType) search.set("eventType", params.eventType)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/capability-audit${qs ? `?${qs}` : ""}`, {
    schema: CapabilityAuditResponseSchema,
  })
}
