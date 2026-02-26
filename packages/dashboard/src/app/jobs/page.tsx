"use client"

import { JobCard } from "@/components/jobs/job-card"
import { JobDetailDrawer } from "@/components/jobs/job-detail-drawer"
import { JobTable } from "@/components/jobs/job-table"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { useJobsPage } from "@/hooks/use-jobs-page"

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function JobsPage(): React.JSX.Element {
  const {
    jobs,
    counts,
    selectedJobId,
    setSelectedJobId,
    isLoading,
    error,
    errorCode,
    handleRefresh,
  } = useJobsPage()

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
      {error && <ApiErrorBanner error={error} errorCode={errorCode} onRetry={handleRefresh} />}

      {/* Empty state */}
      {!isLoading && !error && jobs.length === 0 ? (
        <EmptyState
          icon="list_alt"
          title="No jobs yet"
          description="Jobs will appear here when agents begin executing tasks."
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
