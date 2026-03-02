"use client"

import { useMemo, useState } from "react"

import { EmptyState } from "@/components/layout/empty-state"
import type { JobStatus, JobSummary } from "@/lib/api-client"
import { duration, relativeTime, truncateUuid } from "@/lib/format"

import { JobRetryButton } from "./job-retry-button"
import { JobStatusBadge } from "./job-status-badge"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JobTableProps {
  jobs: JobSummary[]
  onSelectJob?: (jobId: string) => void
  onRetried?: () => void
  /** Controlled status filter — when provided, the dropdown drives server-side filtering */
  statusFilter?: JobStatus | "ALL"
  onStatusFilterChange?: (status: JobStatus | "ALL") => void
}

const PAGE_SIZE = 15

const STATUS_OPTIONS: { label: string; value: JobStatus | "ALL" }[] = [
  { label: "All Statuses", value: "ALL" },
  { label: "Completed", value: "COMPLETED" },
  { label: "Failed", value: "FAILED" },
  { label: "Running", value: "RUNNING" },
  { label: "Pending", value: "PENDING" },
  { label: "Scheduled", value: "SCHEDULED" },
  { label: "Retrying", value: "RETRYING" },
  { label: "Timed Out", value: "TIMED_OUT" },
  { label: "Awaiting Approval", value: "WAITING_FOR_APPROVAL" },
  { label: "Dead Letter", value: "DEAD_LETTER" },
]

const TYPE_OPTIONS = ["ALL", "inference", "tool-call", "pipeline", "batch", "scheduled"] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function JobTable({
  jobs,
  onSelectJob,
  onRetried,
  statusFilter: controlledStatus,
  onStatusFilterChange,
}: JobTableProps): React.JSX.Element {
  const [search, setSearch] = useState("")
  const [localStatus, setLocalStatus] = useState<JobStatus | "ALL">("ALL")
  const [typeFilter, setTypeFilter] = useState<string>("ALL")
  const [page, setPage] = useState(0)

  // Use controlled status filter when provided (server-side filtering)
  const statusFilter = controlledStatus ?? localStatus
  const setStatusFilter = onStatusFilterChange ?? setLocalStatus

  // Filter — skip status filtering when controlled (already filtered server-side)
  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (!controlledStatus && statusFilter !== "ALL" && j.status !== statusFilter) return false
      if (typeFilter !== "ALL" && j.type !== typeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          j.id.toLowerCase().includes(q) ||
          j.agentId.toLowerCase().includes(q) ||
          j.type.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [jobs, search, controlledStatus, statusFilter, typeFilter])

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paginated = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const canRetry = (status: JobStatus) =>
    status === "FAILED" || status === "TIMED_OUT" || status === "DEAD_LETTER"

  // Empty state
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon="work_history"
        title="No jobs found"
        description="Jobs will appear here once agents start executing tasks."
        actionLabel="Go to Agents"
        actionHref="/agents"
        compact
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Filters Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-text-muted">
            search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
            placeholder="Search jobs..."
            className="rounded-lg border-none bg-secondary py-2 pl-10 pr-4 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-text-muted">
            filter_alt
          </span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as JobStatus | "ALL")
              setPage(0)
            }}
            className="cursor-pointer appearance-none rounded-lg border-none bg-secondary py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50"
          >
            {STATUS_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {/* Type Filter */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-text-muted">
            category
          </span>
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value)
              setPage(0)
            }}
            className="cursor-pointer appearance-none rounded-lg border-none bg-secondary py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t === "ALL" ? "All Types" : t}
              </option>
            ))}
          </select>
        </div>

        {/* Result count */}
        <div className="ml-auto text-sm text-text-muted">
          <span className="font-bold text-text-main">{filtered.length}</span>{" "}
          {filtered.length === 1 ? "job" : "jobs"}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-surface-border bg-surface-light shadow-sm">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-surface-border bg-secondary">
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Job ID
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Status
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Agent
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Type
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Duration
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-text-muted">
                Started
              </th>
              <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-text-muted">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {paginated.length === 0 ? (
              <tr>
                <td className="px-6 py-12 text-center text-sm text-text-muted" colSpan={7}>
                  No jobs match the current filters.
                </td>
              </tr>
            ) : (
              paginated.map((job) => {
                const durationMs =
                  job.completedAt && job.createdAt
                    ? new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()
                    : job.updatedAt && job.createdAt
                      ? new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime()
                      : null

                return (
                  <tr
                    key={job.id}
                    className="group cursor-pointer transition-colors hover:bg-primary/5 dark:hover:bg-primary/10"
                    onClick={() => onSelectJob?.(job.id)}
                  >
                    {/* Job ID */}
                    <td className="px-6 py-4">
                      <span className="font-mono text-sm font-bold text-primary">
                        {truncateUuid(job.id)}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-6 py-4">
                      <JobStatusBadge status={job.status} />
                    </td>

                    {/* Agent */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-lg text-text-muted">
                          smart_toy
                        </span>
                        <span className="text-sm text-text-main">{truncateUuid(job.agentId)}</span>
                      </div>
                    </td>

                    {/* Type */}
                    <td className="px-6 py-4">
                      <span className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-text-muted">
                        {job.type}
                      </span>
                    </td>

                    {/* Duration */}
                    <td className="px-6 py-4">
                      <span className="font-mono text-sm text-text-muted">
                        {durationMs !== null ? duration(durationMs) : "—"}
                      </span>
                    </td>

                    {/* Started */}
                    <td className="px-6 py-4">
                      <span className="text-sm text-text-muted">{relativeTime(job.createdAt)}</span>
                    </td>

                    {/* Actions */}
                    <td className="px-6 py-4 text-right">
                      <div
                        className="flex items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectJob?.(job.id)}
                          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
                          title="View details"
                        >
                          <span className="material-symbols-outlined text-xl leading-none">
                            visibility
                          </span>
                        </button>
                        {canRetry(job.status) && (
                          <JobRetryButton jobId={job.id} onRetried={onRetried} />
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">
            Page {safePage + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary disabled:opacity-30"
            >
              <span className="material-symbols-outlined text-lg">chevron_left</span>
            </button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                className={`size-8 rounded-lg text-xs font-bold transition-colors ${
                  i === safePage ? "bg-primary text-white" : "text-text-muted hover:bg-secondary"
                }`}
              >
                {i + 1}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary disabled:opacity-30"
            >
              <span className="material-symbols-outlined text-lg">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
