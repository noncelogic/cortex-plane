"use client"

import { useCallback, useMemo } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { ApiErrorCode } from "@/lib/api-client"
import { listAgents, listApprovals, listJobs, searchMemory } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import {
  type DashboardStats,
  getDashboardStats,
  getRecentJobs,
  type RecentJob,
} from "@/lib/mock/dashboard"

export interface DashboardData {
  stats: DashboardStats
  recentJobs: RecentJob[]
  isLoading: boolean
  error: string | null
  errorCode: ApiErrorCode | null
  refetch: () => void
}

/**
 * Error codes that indicate the control plane is genuinely unreachable or
 * broken. A NOT_FOUND (404) on a list/search endpoint simply means the feature
 * route is not deployed — it should NOT trigger the outage banner.
 */
const CONNECTIVITY_ERROR_CODES = new Set<ApiErrorCode>([
  "CONNECTION_REFUSED",
  "TIMEOUT",
  "SERVER_ERROR",
  "TRANSIENT",
  "AUTH_ERROR",
])

function isConnectivityError(code: ApiErrorCode | null): boolean {
  return code !== null && CONNECTIVITY_ERROR_CODES.has(code)
}

export function useDashboard(): DashboardData {
  const {
    data: agentData,
    isLoading: agentsLoading,
    error: agentsError,
    errorCode: agentsErrorCode,
    refetch: refetchAgents,
  } = useApiQuery(() => listAgents({ limit: 1 }), [])

  const {
    data: jobData,
    isLoading: jobsLoading,
    error: jobsError,
    errorCode: jobsErrorCode,
    refetch: refetchJobs,
  } = useApiQuery(() => listJobs({ limit: 5 }), [])

  const {
    data: approvalData,
    isLoading: approvalsLoading,
    error: approvalsError,
    errorCode: approvalsErrorCode,
    refetch: refetchApprovals,
  } = useApiQuery(() => listApprovals({ status: "PENDING", limit: 1 }), [])

  const {
    data: memoryData,
    isLoading: memoryLoading,
    error: memoryError,
    errorCode: memoryErrorCode,
    refetch: refetchMemory,
  } = useApiQuery(() => searchMemory({ agentId: "*", query: "all", limit: 1 }), [])

  const isLoading = agentsLoading || jobsLoading || approvalsLoading || memoryLoading

  // Only surface errors that indicate a real control-plane connectivity
  // problem. A 404 on /jobs or /memory/search just means the feature isn't
  // deployed yet — not that the plane is down.
  const connectivityFailure = useMemo(() => {
    const sources = [
      { error: agentsError, code: agentsErrorCode },
      { error: jobsError, code: jobsErrorCode },
      { error: approvalsError, code: approvalsErrorCode },
      { error: memoryError, code: memoryErrorCode },
    ]
    return sources.find((s) => isConnectivityError(s.code)) ?? null
  }, [
    agentsError,
    agentsErrorCode,
    jobsError,
    jobsErrorCode,
    approvalsError,
    approvalsErrorCode,
    memoryError,
    memoryErrorCode,
  ])

  const error = connectivityFailure?.error ?? null
  const errorCode = connectivityFailure?.code ?? null

  const stats = useMemo<DashboardStats>(() => {
    if (isMockEnabled()) return getDashboardStats()
    // Use real data where available; features that 404'd stay at 0.
    return {
      totalAgents: agentData?.pagination?.total ?? 0,
      activeJobs: jobData?.pagination?.total ?? 0,
      pendingApprovals: approvalData?.pagination?.total ?? 0,
      memoryRecords: memoryData?.results?.length ?? 0,
    }
  }, [agentData, jobData, approvalData, memoryData])

  const recentJobs = useMemo<RecentJob[]>(() => {
    if (isMockEnabled()) return getRecentJobs()
    if (!jobData?.jobs || jobData.jobs.length === 0) return []
    return jobData.jobs.map((j) => ({
      id: j.id,
      agentName: j.agentId,
      status: j.status,
      type: j.type,
      createdAt: j.createdAt,
    }))
  }, [jobData])

  const refetch = useCallback(() => {
    void refetchAgents()
    void refetchJobs()
    void refetchApprovals()
    void refetchMemory()
  }, [refetchAgents, refetchJobs, refetchApprovals, refetchMemory])

  return { stats, recentJobs, isLoading, error, errorCode, refetch }
}
