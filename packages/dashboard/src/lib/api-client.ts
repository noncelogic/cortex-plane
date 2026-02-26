/**
 * Typed REST client for the Cortex Plane Control API.
 *
 * Types mirror the OpenAPI 3.1 specification (docs/openapi.yaml).
 * Implementation is a thin wrapper around fetch() with auth headers,
 * retry logic for transient errors, and request timeouts.
 */

import type { z } from "zod"

import {
  AgentDetailSchema,
  AgentListResponseSchema,
} from "./schemas/agents"
import { ApprovalListResponseSchema } from "./schemas/approvals"
import {
  BrowserSessionSchema,
} from "./schemas/browser"
import { ContentListResponseSchema } from "./schemas/content"
import { JobDetailSchema, JobListResponseSchema } from "./schemas/jobs"
import { MemorySearchResponseSchema } from "./schemas/memory"

// ---------------------------------------------------------------------------
// Re-export types from schemas for backward compatibility
// ---------------------------------------------------------------------------

export type { AgentStatus, AgentLifecycleState, AgentSummary, AgentDetail, Checkpoint } from "./schemas/agents"
export type { JobStatus, JobSummary, JobStep, JobMetrics, JobLogEntry, JobDetail } from "./schemas/jobs"
export type { ApprovalStatus, ApprovalRequest } from "./schemas/approvals"
export type { Pagination } from "./schemas/common"
export type { MemoryRecord } from "./schemas/memory"
export type { ContentStatus, ContentType, ContentPiece, ContentPipelineStats } from "./schemas/content"
export type {
  BrowserSessionStatus,
  BrowserEventType,
  BrowserEventSeverity,
  BrowserTab,
  BrowserSession,
  BrowserEvent,
  Screenshot,
} from "./schemas/browser"

// ---------------------------------------------------------------------------
// Types that remain local (request/response shapes not validated)
// ---------------------------------------------------------------------------

export interface SteerRequest {
  message: string
  priority?: "normal" | "high"
}

export interface SteerResponse {
  steerMessageId: string
  status: "accepted"
  agentId: string
  priority: "normal" | "high"
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

const API_BASE = process.env.NEXT_PUBLIC_CORTEX_API_URL ?? "http://localhost:4000"

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

async function apiFetch<T>(path: string, options: FetchOptions & { schema?: z.ZodType<T> } = {}): Promise<T> {
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

  // API key auth for initial scaffold (session tokens later)
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
      })

      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)

      if (!res.ok) {
        const errorBody: unknown = await res.json().catch(() => null)
        const code = classifyError(res.status)

        // Parse as RFC 7807 ProblemDetail if possible
        if (errorBody && typeof errorBody === "object" && "type" in errorBody) {
          const problem = errorBody as ProblemDetail
          const err = new ApiError(res.status, problem.detail ?? problem.title ?? res.statusText, problem, code)
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

      const data = await res.json()
      return schema ? schema.parse(data) as T : data as T
    } catch (err) {
      clearTimeout(timeoutId)
      externalSignal?.removeEventListener("abort", onExternalAbort)

      if (err instanceof ApiError) throw err

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
}

// ---------------------------------------------------------------------------
// Typed endpoint functions
// ---------------------------------------------------------------------------

export async function listAgents(params?: {
  status?: string
  lifecycleState?: string
  limit?: number
  offset?: number
}): Promise<{ agents: import("./schemas/agents").AgentSummary[]; pagination: import("./schemas/common").Pagination }> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.lifecycleState) search.set("lifecycleState", params.lifecycleState)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents${qs ? `?${qs}` : ""}`, { schema: AgentListResponseSchema })
}

export async function getAgent(agentId: string): Promise<import("./schemas/agents").AgentDetail> {
  return apiFetch(`/agents/${agentId}`, { schema: AgentDetailSchema })
}

export async function steerAgent(agentId: string, request: SteerRequest): Promise<SteerResponse> {
  return apiFetch(`/agents/${agentId}/steer`, { method: "POST", body: request })
}

export async function pauseAgent(
  agentId: string,
  options?: { reason?: string; timeoutSeconds?: number },
): Promise<{ agentId: string; status: "pausing" }> {
  return apiFetch(`/agents/${agentId}/pause`, { method: "POST", body: options })
}

export async function resumeAgent(
  agentId: string,
  options?: { checkpointId?: string; instruction?: string },
): Promise<{ agentId: string; status: "resuming"; fromCheckpoint?: string }> {
  return apiFetch(`/agents/${agentId}/resume`, { method: "POST", body: options })
}

export async function listApprovals(params?: {
  status?: string
  jobId?: string
  limit?: number
  offset?: number
}): Promise<{ approvals: import("./schemas/approvals").ApprovalRequest[]; pagination: import("./schemas/common").Pagination }> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.jobId) search.set("jobId", params.jobId)
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
): Promise<{ approvalRequestId: string; decision: string; decidedAt: string }> {
  return apiFetch(`/approval/${approvalId}/decide`, {
    method: "POST",
    body: { decision, decidedBy, channel: "dashboard", reason },
  })
}

export async function listJobs(params?: {
  agentId?: string
  status?: string
  limit?: number
  offset?: number
}): Promise<{ jobs: import("./schemas/jobs").JobSummary[]; pagination: import("./schemas/common").Pagination }> {
  const search = new URLSearchParams()
  if (params?.agentId) search.set("agentId", params.agentId)
  if (params?.status) search.set("status", params.status)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/jobs${qs ? `?${qs}` : ""}`, { schema: JobListResponseSchema })
}

export async function getJob(jobId: string): Promise<import("./schemas/jobs").JobDetail> {
  return apiFetch(`/jobs/${jobId}`, { schema: JobDetailSchema })
}

export async function retryJob(
  jobId: string,
): Promise<{ jobId: string; status: "retrying" }> {
  return apiFetch(`/jobs/${jobId}/retry`, { method: "POST" })
}

export async function searchMemory(params: {
  agentId: string
  query: string
  limit?: number
}): Promise<{ results: import("./schemas/memory").MemoryRecord[] }> {
  const search = new URLSearchParams()
  search.set("agentId", params.agentId)
  search.set("query", params.query)
  if (params.limit) search.set("limit", String(params.limit))
  return apiFetch(`/memory/search?${search.toString()}`, { schema: MemorySearchResponseSchema })
}

export async function syncMemory(
  agentId: string,
  direction?: "file_to_qdrant" | "qdrant_to_file" | "bidirectional",
): Promise<{
  syncId: string
  status: string
  stats: { upserted: number; deleted: number; unchanged: number }
}> {
  return apiFetch("/memory/sync", { method: "POST", body: { agentId, direction } })
}

// ---------------------------------------------------------------------------
// Content pipeline endpoint functions
// ---------------------------------------------------------------------------

export async function listContent(params?: {
  status?: string
  type?: string
  agentId?: string
  limit?: number
  offset?: number
}): Promise<{ content: import("./schemas/content").ContentPiece[]; pagination: import("./schemas/common").Pagination }> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.type) search.set("type", params.type)
  if (params?.agentId) search.set("agentId", params.agentId)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/content${qs ? `?${qs}` : ""}`, { schema: ContentListResponseSchema })
}

export async function publishContent(
  contentId: string,
  channel: string,
): Promise<{ contentId: string; status: "published"; publishedAt: string }> {
  return apiFetch(`/content/${contentId}/publish`, {
    method: "POST",
    body: { channel },
  })
}

export async function archiveContent(
  contentId: string,
): Promise<{ contentId: string; status: "archived" }> {
  return apiFetch(`/content/${contentId}/archive`, { method: "POST" })
}

// ---------------------------------------------------------------------------
// Browser observation endpoint functions
// ---------------------------------------------------------------------------

export async function getAgentBrowser(agentId: string): Promise<import("./schemas/browser").BrowserSession> {
  return apiFetch(`/agents/${agentId}/browser`, { schema: BrowserSessionSchema })
}

export async function getAgentScreenshots(
  agentId: string,
  limit?: number,
): Promise<{ screenshots: import("./schemas/browser").Screenshot[] }> {
  const search = new URLSearchParams()
  if (limit) search.set("limit", String(limit))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/browser/screenshots${qs ? `?${qs}` : ""}`)
}

export async function getAgentBrowserEvents(
  agentId: string,
  limit?: number,
  types?: string[],
): Promise<{ events: import("./schemas/browser").BrowserEvent[] }> {
  const search = new URLSearchParams()
  if (limit) search.set("limit", String(limit))
  if (types?.length) search.set("types", types.join(","))
  const qs = search.toString()
  return apiFetch(`/agents/${agentId}/browser/events${qs ? `?${qs}` : ""}`)
}

// Re-export the old name for backward compat within this PR
export { approveRequest as decideApproval }
