"use client"

import { useCallback, useMemo } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { ApiErrorCode, JobStatus } from "@/lib/api-client"
import { listAgents, listApprovals, listJobs } from "@/lib/api-client"

export interface DashboardStats {
  totalAgents: number
  activeJobs: number
  pendingApprovals: number
  memoryRecords: number
}

export interface RecentJob {
  id: string
  agent_name: string
  status: JobStatus
  type: string
  created_at: string
}

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

  const isLoading = agentsLoading || jobsLoading || approvalsLoading
  const error = agentsError || jobsError || approvalsError
  const errorCode = agentsErrorCode || jobsErrorCode || approvalsErrorCode || null

  const stats = useMemo<DashboardStats>(() => {
    return {
      totalAgents: agentData?.pagination?.total ?? 0,
      activeJobs: jobData?.pagination?.total ?? 0,
      pendingApprovals: approvalData?.pagination?.total ?? 0,
      memoryRecords: 0,
    }
  }, [agentData, jobData, approvalData])

  const recentJobs = useMemo<RecentJob[]>(() => {
    if (!jobData?.jobs || jobData.jobs.length === 0) return []
    return jobData.jobs.map((j) => ({
      id: j.id,
      agent_name: j.agent_id,
      status: j.status,
      type: j.type,
      created_at: j.created_at,
    }))
  }, [jobData])

  const refetch = useCallback(() => {
    void refetchAgents()
    void refetchJobs()
    void refetchApprovals()
  }, [refetchAgents, refetchJobs, refetchApprovals])

  return { stats, recentJobs, isLoading, error, errorCode, refetch }
}
