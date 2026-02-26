"use client"

import { useCallback, useMemo, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { JobSummary } from "@/lib/api-client"
import { listJobs } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import { generateMockJobs } from "@/lib/mock/jobs"

function statusCounts(jobs: JobSummary[]): { running: number; failed: number; completed: number } {
  let running = 0
  let failed = 0
  let completed = 0
  for (const j of jobs) {
    if (j.status === "RUNNING") running++
    else if (j.status === "FAILED" || j.status === "DEAD_LETTER") failed++
    else if (j.status === "COMPLETED") completed++
  }
  return { running, failed, completed }
}

export function useJobsPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () => listJobs({ limit: 100 }),
    [],
  )

  const jobs: JobSummary[] = useMemo(() => {
    // Mock mode: always return mock data
    if (isMockEnabled()) return generateMockJobs()
    // Live mode: return API data (may be empty array)
    if (data?.jobs) return data.jobs
    // Still loading or errored in live mode: return empty
    return []
  }, [data])

  const counts = useMemo(() => statusCounts(jobs), [jobs])

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  return {
    jobs,
    counts,
    selectedJobId,
    setSelectedJobId,
    isLoading,
    error,
    errorCode: errorCode,
    handleRefresh,
  }
}
