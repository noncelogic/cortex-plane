"use client"

import type { JobSummary } from "@/lib/api-client"
import { duration, relativeTime, truncateUuid } from "@/lib/format"

import { JobStatusBadge } from "./job-status-badge"

interface JobCardProps {
  job: JobSummary
  onSelect?: (id: string) => void
}

export function JobCard({ job, onSelect }: JobCardProps): React.JSX.Element {
  const durationMs =
    job.completedAt && job.createdAt
      ? new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()
      : job.updatedAt && job.createdAt
        ? new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime()
        : null

  return (
    <div
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:shadow-md dark:border-primary/10 dark:bg-slate-900/50"
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(job.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect?.(job.id)
      }}
    >
      {/* Header: Job ID + Status */}
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-sm font-bold text-primary">
          {truncateUuid(job.id)}
        </span>
        <JobStatusBadge status={job.status} />
      </div>

      {/* Agent + Type */}
      <div className="mb-3 space-y-1">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-slate-400">smart_toy</span>
          <span className="text-sm text-slate-900 dark:text-slate-100">
            {truncateUuid(job.agentId)}
          </span>
        </div>
        <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {job.type}
        </span>
      </div>

      {/* Footer: Duration + Time */}
      <div className="flex items-center justify-between border-t border-slate-100 pt-3 dark:border-primary/5">
        <span className="font-mono text-xs text-slate-500">
          {durationMs !== null ? duration(durationMs) : "—"}
        </span>
        <span className="text-xs text-slate-400">{relativeTime(job.createdAt)}</span>
      </div>

      {/* Error preview */}
      {job.error && (
        <div className="mt-3 truncate rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {job.error}
        </div>
      )}
    </div>
  )
}
