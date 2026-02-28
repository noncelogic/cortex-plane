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
import { ContentListResponseSchema } from "./schemas/content"
import {
  CredentialListResponseSchema,
  OAuthInitResultSchema,
  ProviderListResponseSchema,
} from "./schemas/credentials"
import { JobDetailSchema, JobListResponseSchema } from "./schemas/jobs"
import { MemorySearchResponseSchema } from "./schemas/memory"

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
  JobDetail,
  JobLogEntry,
  JobMetrics,
  JobStatus,
  JobStep,
  JobSummary,
} from "./schemas/jobs"
export type { MemoryRecord } from "./schemas/memory"

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
  | "SERVER_ERROR"
  | "TRANSIENT"
  | "SCHEMA_MISMATCH"
  | "UNKNOWN"

function classifyError(status: number): ApiErrorCode {
  if (status === 401 || status === 403) return "AUTH_ERROR"
  if (status === 404) return "NOT_FOUND"
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
      return schema ? schema.parse(data) : (data as T)
    } catch (err) {
      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)

      if (err instanceof ApiError) throw err

      // Schema validation errors (e.g. ZodError) mean the API responded
      // successfully but with an unexpected shape — not a connectivity issue.
      if (err instanceof Error && err.name === "ZodError") {
        throw new ApiError(
          0,
          "Unexpected response format from the control plane",
          undefined,
          "SCHEMA_MISMATCH",
        )
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

  /** True when the endpoint itself doesn't exist (feature not deployed). */
  get isFeatureUnavailable(): boolean {
    return this.code === "NOT_FOUND"
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
}

export interface UpdateAgentRequest {
  name?: string
  role?: string
  description?: string | null
  model_config?: Record<string, unknown>
  skill_config?: Record<string, unknown>
  resource_limits?: Record<string, unknown>
  channel_permissions?: Record<string, unknown>
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
  body: { pastedUrl: string; code_verifier: string; state: string },
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
