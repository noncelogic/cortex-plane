"use client"

import { useCallback, useMemo } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { ApiErrorCode, JobStatus } from "@/lib/api-client"
import { getDashboardActivity, getDashboardSummary } from "@/lib/api-client"
import type { ActivityEvent } from "@/lib/schemas/jobs"

export interface DashboardStats {
  totalAgents: number
  activeJobs: number
  pendingApprovals: number
  memoryRecords: number
}

export interface DashboardTrends {
  totalAgents24h: number
  activeJobs24h: number
  pendingApprovals24h: number
  memoryRecords24h: number
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
  trends: DashboardTrends
  recentJobs: RecentJob[]
  activityEvents: ActivityEvent[]
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
  } = useApiQuery(() => getDashboardActivity({ limit: 10 }), [])

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

  const trends = useMemo<DashboardTrends>(() => {
    return {
      totalAgents24h: summaryData?.trends?.totalAgents24h ?? 0,
      activeJobs24h: summaryData?.trends?.activeJobs24h ?? 0,
      pendingApprovals24h: summaryData?.trends?.pendingApprovals24h ?? 0,
      memoryRecords24h: summaryData?.trends?.memoryRecords24h ?? 0,
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

  const activityEvents = useMemo<ActivityEvent[]>(() => {
    return activityData?.events ?? []
  }, [activityData])

  const refetch = useCallback(() => {
    void refetchSummary()
    void refetchActivity()
  }, [refetchSummary, refetchActivity])

  return { stats, trends, recentJobs, activityEvents, isLoading, error, errorCode, refetch }
}
