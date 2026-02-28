"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import { useJobStream } from "@/hooks/use-job-stream"
import type { JobStatus, JobSummary } from "@/lib/api-client"
import { listJobs } from "@/lib/api-client"

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
  const [statusFilter, setStatusFilter] = useState<JobStatus | "ALL">("ALL")

  const {
    data,
    isLoading,
    error: rawError,
    errorCode: rawErrorCode,
    refetch,
  } = useApiQuery(
    () =>
      listJobs({
        status: statusFilter !== "ALL" ? statusFilter : undefined,
        limit: 100,
      }),
    [statusFilter],
  )

  // SSE: auto-refresh when jobs change status
  const { events } = useJobStream()
  const prevEventCount = useRef(0)
  useEffect(() => {
    if (events.length > prevEventCount.current) {
      prevEventCount.current = events.length
      void refetch()
    }
  }, [events.length, refetch])

  // A 404 means the /jobs route isn't deployed — not a connection failure.
  // Suppress it so the page shows the empty state instead of an error banner.
  const error = rawErrorCode === "NOT_FOUND" ? null : rawError
  const errorCode = rawErrorCode === "NOT_FOUND" ? null : rawErrorCode

  const jobs: JobSummary[] = useMemo(() => {
    if (data?.jobs) return data.jobs
    return []
  }, [data])

  const counts = useMemo(() => statusCounts(jobs), [jobs])

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  const exportJobs = useCallback(
    (format: "csv" | "json") => {
      if (jobs.length === 0) return

      let content: string
      let mimeType: string
      let filename: string

      if (format === "json") {
        content = JSON.stringify(jobs, null, 2)
        mimeType = "application/json"
        filename = "jobs.json"
      } else {
        const headers = ["id", "agentId", "status", "type", "createdAt", "updatedAt", "error"]
        const rows = jobs.map((j) =>
          headers.map((h) => {
            const val = j[h as keyof JobSummary] ?? ""
            const str = String(val)
            return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str
          }),
        )
        content = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")
        mimeType = "text/csv"
        filename = "jobs.csv"
      }

      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    },
    [jobs],
  )

  return {
    jobs,
    counts,
    selectedJobId,
    setSelectedJobId,
    statusFilter,
    setStatusFilter,
    isLoading,
    error,
    errorCode,
    handleRefresh,
    exportJobs,
  }
}
