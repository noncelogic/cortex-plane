/**
 * Typed REST client for the Cortex Plane Control API.
 *
 * Types mirror the OpenAPI 3.1 specification (docs/openapi.yaml).
 * Implementation is a thin wrapper around fetch() with auth headers.
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
// API Client
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_CORTEX_API_URL ?? "http://localhost:4000"

interface FetchOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

async function apiFetch<T>(path: string, options: FetchOptions & { schema?: z.ZodType<T> } = {}): Promise<T> {
  const { method = "GET", body, signal, schema } = options

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  // API key auth for initial scaffold (session tokens later)
  const apiKey = process.env.NEXT_PUBLIC_CORTEX_API_KEY
  if (apiKey) {
    headers["X-API-Key"] = apiKey
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })

  if (!res.ok) {
    const errorBody: unknown = await res.json().catch(() => null)
    // Parse as RFC 7807 ProblemDetail if possible
    if (errorBody && typeof errorBody === "object" && "type" in errorBody) {
      const problem = errorBody as ProblemDetail
      throw new ApiError(res.status, problem.detail ?? problem.title ?? res.statusText, problem)
    }
    const detail =
      (errorBody as Record<string, string> | null)?.detail ??
      (errorBody as Record<string, string> | null)?.message ??
      res.statusText
    throw new ApiError(res.status, detail)
  }

  const data = await res.json()
  return schema ? schema.parse(data) as T : data as T
}

export class ApiError extends Error {
  public readonly problem?: ProblemDetail

  constructor(
    public status: number,
    message: string,
    problem?: ProblemDetail,
  ) {
    super(message)
    this.name = "ApiError"
    this.problem = problem
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
