"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import { useJobStream } from "@/hooks/use-job-stream"
import type { JobStatus, JobSummary } from "@/lib/api-client"
import { listAgents, listJobs } from "@/lib/api-client"

const PAGE_SIZE = 25

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
  const [agentFilter, setAgentFilter] = useState<string>("ALL")
  const [page, setPage] = useState(0)

  // Reset page when filters change
  const handleStatusFilter = useCallback((status: JobStatus | "ALL") => {
    setStatusFilter(status)
    setPage(0)
  }, [])

  const handleAgentFilter = useCallback((agentId: string) => {
    setAgentFilter(agentId)
    setPage(0)
  }, [])

  // Fetch agents for the agent filter dropdown
  const { data: agentsData } = useApiQuery(() => listAgents({ limit: 200 }), [])

  const agents = useMemo(() => {
    if (!agentsData?.agents) return []
    return agentsData.agents.map((a) => ({ id: a.id, name: a.name }))
  }, [agentsData])

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
        agent_id: agentFilter !== "ALL" ? agentFilter : undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [statusFilter, agentFilter, page],
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

  const pagination = useMemo(() => {
    if (data?.pagination) return data.pagination
    return { total: 0, limit: PAGE_SIZE, offset: 0, hasMore: false }
  }, [data])

  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE))

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
        const headers = [
          "id",
          "agentId",
          "status",
          "type",
          "createdAt",
          "updatedAt",
          "costUsd",
          "error",
        ]
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
    agents,
    selectedJobId,
    setSelectedJobId,
    statusFilter,
    setStatusFilter: handleStatusFilter,
    agentFilter,
    setAgentFilter: handleAgentFilter,
    page,
    setPage,
    totalPages,
    pagination,
    isLoading,
    error,
    errorCode,
    handleRefresh,
    exportJobs,
  }
}
