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
    refetch: refetchJobs,
  } = useApiQuery(() => listJobs({ limit: 5 }), [])

  const {
    data: approvalData,
    isLoading: approvalsLoading,
    refetch: refetchApprovals,
  } = useApiQuery(() => listApprovals({ status: "PENDING", limit: 1 }), [])

  const {
    data: memoryData,
    isLoading: memoryLoading,
    refetch: refetchMemory,
  } = useApiQuery(() => searchMemory({ agentId: "*", query: "all", limit: 1 }), [])

  const isLoading = agentsLoading || jobsLoading || approvalsLoading || memoryLoading
  const error = agentsError || jobsError
  const errorCode = agentsErrorCode

  const stats = useMemo<DashboardStats>(() => {
    if (isMockEnabled()) return getDashboardStats()
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
