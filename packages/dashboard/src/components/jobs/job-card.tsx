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
    job.completed_at && job.created_at
      ? new Date(job.completed_at).getTime() - new Date(job.created_at).getTime()
      : job.updated_at && job.created_at
        ? new Date(job.updated_at).getTime() - new Date(job.created_at).getTime()
        : null

  return (
    <div
      className="rounded-xl border border-surface-border bg-surface-light p-4 shadow-sm transition-all duration-200 hover:shadow-md"
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(job.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect?.(job.id)
      }}
    >
      {/* Header: Job ID + Status */}
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-sm font-bold text-primary">{truncateUuid(job.id)}</span>
        <JobStatusBadge status={job.status} />
      </div>

      {/* Agent + Type */}
      <div className="mb-3 space-y-1">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-text-muted">smart_toy</span>
          <span className="text-sm text-text-main">{truncateUuid(job.agent_id)}</span>
        </div>
        <span className="inline-block rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-text-muted">
          {job.type}
        </span>
      </div>

      {/* Footer: Duration + Time */}
      <div className="flex items-center justify-between border-t border-surface-border pt-3">
        <span className="font-mono text-xs text-text-muted">
          {durationMs !== null ? duration(durationMs) : "—"}
        </span>
        <span className="text-xs text-text-muted">{relativeTime(job.created_at)}</span>
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
