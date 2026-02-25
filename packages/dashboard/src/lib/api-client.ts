/**
 * Typed REST client for the Cortex Plane Control API.
 *
 * Types mirror the OpenAPI 3.1 specification (docs/openapi.yaml).
 * Implementation is a thin wrapper around fetch() with auth headers.
 */

// ---------------------------------------------------------------------------
// Shared types (from OpenAPI spec)
// ---------------------------------------------------------------------------

export type AgentStatus = "ACTIVE" | "DISABLED" | "ARCHIVED"

export type AgentLifecycleState =
  | "BOOTING"
  | "HYDRATING"
  | "READY"
  | "EXECUTING"
  | "DRAINING"
  | "TERMINATED"

export interface AgentSummary {
  id: string
  name: string
  slug: string
  role: string
  description?: string
  status: AgentStatus
  lifecycleState: AgentLifecycleState
  currentJobId?: string
  createdAt: string
  updatedAt?: string
}

export interface AgentDetail extends AgentSummary {
  modelConfig?: Record<string, unknown>
  skillConfig?: Record<string, unknown>
  resourceLimits?: Record<string, unknown>
  channelPermissions?: Record<string, unknown>
  checkpoint?: Checkpoint
}

export interface Checkpoint {
  jobId: string
  savedAt: string
  crc32: number
  data?: Record<string, unknown>
}

export type JobStatus =
  | "PENDING"
  | "SCHEDULED"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "RETRYING"
  | "DEAD_LETTER"

export interface JobSummary {
  id: string
  agentId: string
  status: JobStatus
  type: string
  createdAt: string
  updatedAt?: string
  completedAt?: string
  error?: string
}

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"

export interface ApprovalRequest {
  id: string
  jobId: string
  agentId?: string
  status: ApprovalStatus
  actionType: string
  actionSummary: string
  actionDetail?: Record<string, unknown>
  approverUserAccountId?: string
  requestedAt: string
  decidedAt?: string
  decidedBy?: string
  expiresAt: string
  decision?: "APPROVED" | "REJECTED"
  reason?: string
}

export interface Pagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface MemoryRecord {
  id: string
  type: "fact" | "preference" | "event" | "system_rule"
  content: string
  tags: string[]
  people: string[]
  projects: string[]
  importance: 1 | 2 | 3 | 4 | 5
  confidence: number
  source: string
  createdAt: number
  accessCount: number
  lastAccessedAt: number
  score?: number
}

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

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options

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

  return res.json() as Promise<T>
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
  status?: AgentStatus
  lifecycleState?: AgentLifecycleState
  limit?: number
  offset?: number
}): Promise<{ agents: AgentSummary[]; pagination: Pagination }> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.lifecycleState) search.set("lifecycleState", params.lifecycleState)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/agents${qs ? `?${qs}` : ""}`)
}

export async function getAgent(agentId: string): Promise<AgentDetail> {
  return apiFetch(`/agents/${agentId}`)
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
  status?: ApprovalStatus
  jobId?: string
  limit?: number
  offset?: number
}): Promise<{ approvals: ApprovalRequest[]; pagination: Pagination }> {
  const search = new URLSearchParams()
  if (params?.status) search.set("status", params.status)
  if (params?.jobId) search.set("jobId", params.jobId)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/approvals${qs ? `?${qs}` : ""}`)
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
  status?: JobStatus
  limit?: number
  offset?: number
}): Promise<{ jobs: JobSummary[]; pagination: Pagination }> {
  const search = new URLSearchParams()
  if (params?.agentId) search.set("agentId", params.agentId)
  if (params?.status) search.set("status", params.status)
  if (params?.limit) search.set("limit", String(params.limit))
  if (params?.offset) search.set("offset", String(params.offset))
  const qs = search.toString()
  return apiFetch(`/jobs${qs ? `?${qs}` : ""}`)
}

export async function searchMemory(params: {
  agentId: string
  query: string
  limit?: number
}): Promise<{ results: MemoryRecord[] }> {
  const search = new URLSearchParams()
  search.set("agentId", params.agentId)
  search.set("query", params.query)
  if (params.limit) search.set("limit", String(params.limit))
  return apiFetch(`/memory/search?${search.toString()}`)
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

// Re-export the old name for backward compat within this PR
export { approveRequest as decideApproval }
