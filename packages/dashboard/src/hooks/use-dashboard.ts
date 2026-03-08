"use client"

import { useCallback, useMemo } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { ApiErrorCode, JobStatus } from "@/lib/api-client"
import { getDashboardActivity, getDashboardSummary } from "@/lib/api-client"

export interface DashboardStats {
  totalAgents: number
  activeJobs: number
  pendingApprovals: number
  memoryRecords: number
}

export interface RecentJob {
  id: string
  agentName: string
  status: JobStatus
  type: string
  createdAt: string
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
    data: summaryData,
    isLoading: summaryLoading,
    error: summaryError,
    errorCode: summaryErrorCode,
    refetch: refetchSummary,
  } = useApiQuery(() => getDashboardSummary(), [])

  const {
    data: activityData,
    isLoading: activityLoading,
    error: activityError,
    errorCode: activityErrorCode,
    refetch: refetchActivity,
  } = useApiQuery(() => getDashboardActivity({ limit: 5 }), [])

  const isLoading = summaryLoading || activityLoading
  const error = summaryError || activityError
  const errorCode = summaryErrorCode || activityErrorCode || null

  const stats = useMemo<DashboardStats>(() => {
    return {
      totalAgents: summaryData?.totalAgents ?? 0,
      activeJobs: summaryData?.activeJobs ?? 0,
      pendingApprovals: summaryData?.pendingApprovals ?? 0,
      memoryRecords: summaryData?.memoryRecords ?? 0,
    }
  }, [summaryData])

  const recentJobs = useMemo<RecentJob[]>(() => {
    if (!activityData?.activity || activityData.activity.length === 0) return []
    return activityData.activity.map((j) => ({
      id: j.id,
      agentName: j.agentId,
      status: j.status,
      type: j.type,
      createdAt: j.createdAt,
    }))
  }, [activityData])

  const refetch = useCallback(() => {
    void refetchSummary()
    void refetchActivity()
  }, [refetchSummary, refetchActivity])

  return { stats, recentJobs, isLoading, error, errorCode, refetch }
}
