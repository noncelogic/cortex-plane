"use client"

import { useCallback, useMemo, useState } from "react"

import { JobCard } from "@/components/jobs/job-card"
import { JobDetailDrawer } from "@/components/jobs/job-detail-drawer"
import { JobTable } from "@/components/jobs/job-table"
import { Skeleton } from "@/components/layout/skeleton"
import { useApiQuery } from "@/hooks/use-api"
import type { JobStatus, JobSummary } from "@/lib/api-client"
import { listJobs } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Mock data for development (until API is live)
// ---------------------------------------------------------------------------

function generateMockJobs(): JobSummary[] {
  const statuses: JobStatus[] = [
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "RUNNING",
    "PENDING",
    "SCHEDULED",
    "RETRYING",
    "TIMED_OUT",
    "WAITING_FOR_APPROVAL",
    "DEAD_LETTER",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "RUNNING",
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "COMPLETED",
    "RUNNING",
    "PENDING",
    "COMPLETED",
    "COMPLETED",
    "SCHEDULED",
  ]
  const types = ["inference", "tool-call", "pipeline", "batch", "scheduled"]
  const agents = [
    "agt-a1b2c3d4",
    "agt-e5f6g7h8",
    "agt-i9j0k1l2",
    "agt-m3n4o5p6",
    "agt-q7r8s9t0",
  ]
  const now = Date.now()

  return statuses.map((status, i) => {
    const createdAt = new Date(now - (i + 1) * 1_800_000 - Math.random() * 3_600_000)
    const durationMs = 15_000 + Math.floor(Math.random() * 300_000)
    const completedAt =
      status === "RUNNING" || status === "PENDING" || status === "SCHEDULED"
        ? undefined
        : new Date(createdAt.getTime() + durationMs).toISOString()

    return {
      id: `job-${String(i + 1).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`,
      agentId: agents[i % agents.length]!,
      status,
      type: types[i % types.length]!,
      createdAt: createdAt.toISOString(),
      updatedAt: new Date(createdAt.getTime() + durationMs).toISOString(),
      completedAt,
      error:
        status === "FAILED"
          ? "Model inference timeout — upstream provider returned 504"
          : status === "DEAD_LETTER"
            ? "Max retry attempts exceeded (3/3)"
            : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Status summary helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JobsPage(): React.JSX.Element {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  // Fetch from API; fall back to mock data
  const { data, isLoading, error, refetch } = useApiQuery(
    () => listJobs({ limit: 100 }),
    [],
  )

  const jobs: JobSummary[] = useMemo(() => {
    if (data?.jobs && data.jobs.length > 0) return data.jobs
    // Fall back to mock data during development
    if (error || (!isLoading && (!data?.jobs || data.jobs.length === 0))) {
      return generateMockJobs()
    }
    return data?.jobs ?? []
  }, [data, error, isLoading])

  const counts = useMemo(() => statusCounts(jobs), [jobs])

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  // Loading skeleton
  if (isLoading && jobs.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[28px] text-primary">list_alt</span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text-main dark:text-white">
            Job History
          </h1>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-main dark:text-slate-100">
            Job History
          </h1>
          <p className="max-w-lg text-slate-500 dark:text-slate-400">
            Track execution history, monitor active jobs, and retry failed tasks.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-lg">download</span>
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/20"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {/* Status summary pills */}
      <div className="flex flex-wrap items-center gap-3">
        {counts.running > 0 && (
          <div className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1.5">
            <div className="size-2 animate-pulse rounded-full bg-blue-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-blue-400">
              {counts.running} Running
            </span>
          </div>
        )}
        {counts.failed > 0 && (
          <div className="flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1.5">
            <div className="size-2 rounded-full bg-red-500" />
            <span className="text-xs font-bold uppercase tracking-wider text-red-400">
              {counts.failed} Failed
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5">
          <div className="size-2 rounded-full bg-emerald-500" />
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-500">
            {counts.completed} Completed
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4 text-sm text-red-500">
          Failed to load jobs: {error}
        </div>
      )}

      {/* Desktop: Table view */}
      <div className="hidden md:block">
        <JobTable
          jobs={jobs}
          onSelectJob={setSelectedJobId}
          onRetried={handleRefresh}
        />
      </div>

      {/* Mobile: Card view */}
      <div className="grid grid-cols-1 gap-3 md:hidden">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} onSelect={setSelectedJobId} />
        ))}
      </div>

      {/* Detail Drawer */}
      <JobDetailDrawer
        jobId={selectedJobId}
        onClose={() => setSelectedJobId(null)}
        onRetried={handleRefresh}
      />
    </div>
  )
}
