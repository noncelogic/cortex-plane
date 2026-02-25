'use client'

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

  const { data, isLoading, error, refetch } = useApiQuery(
    () => listJobs({ limit: 100 }),
    [],
  )

  const jobs: JobSummary[] = useMemo(() => {
    if (data?.jobs && data.jobs.length > 0) return data.jobs
    if (error || isMockEnabled() || (!isLoading && (!data?.jobs || data.jobs.length === 0))) {
      return generateMockJobs()
    }
    return data?.jobs ?? []
  }, [data, error, isLoading])

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
    handleRefresh,
  }
}
