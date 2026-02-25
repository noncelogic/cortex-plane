"use client"

import { useMemo, useState } from "react"

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

export function JobTable({ jobs, onSelectJob, onRetried }: JobTableProps): React.JSX.Element {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<JobStatus | "ALL">("ALL")
  const [typeFilter, setTypeFilter] = useState<string>("ALL")
  const [page, setPage] = useState(0)

  // Filter
  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (statusFilter !== "ALL" && j.status !== statusFilter) return false
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
  }, [jobs, search, statusFilter, typeFilter])

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paginated = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const canRetry = (status: JobStatus) =>
    status === "FAILED" || status === "TIMED_OUT" || status === "DEAD_LETTER"

  // Empty state
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center dark:border-slate-700">
        <span className="material-symbols-outlined mb-3 text-4xl text-slate-400">
          work_history
        </span>
        <p className="text-sm font-medium text-slate-500">No jobs found.</p>
        <p className="mt-1 text-xs text-slate-400">
          Jobs will appear here once agents start executing tasks.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Filters Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
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
            className="rounded-lg border-none bg-slate-100 py-2 pl-10 pr-4 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
          />
        </div>

        {/* Status Filter */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            filter_alt
          </span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as JobStatus | "ALL")
              setPage(0)
            }}
            className="cursor-pointer appearance-none rounded-lg border-none bg-slate-100 py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
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
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            category
          </span>
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value)
              setPage(0)
            }}
            className="cursor-pointer appearance-none rounded-lg border-none bg-slate-100 py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t === "ALL" ? "All Types" : t}
              </option>
            ))}
          </select>
        </div>

        {/* Result count */}
        <div className="ml-auto text-sm text-slate-500 dark:text-slate-400">
          <span className="font-bold text-slate-900 dark:text-slate-100">{filtered.length}</span>{" "}
          {filtered.length === 1 ? "job" : "jobs"}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/20">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/50">
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Job ID
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Status
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Agent
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Type
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Duration
              </th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Started
              </th>
              <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {paginated.length === 0 ? (
              <tr>
                <td
                  className="px-6 py-12 text-center text-sm text-slate-500"
                  colSpan={7}
                >
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
                        <span className="material-symbols-outlined text-lg text-slate-400">
                          smart_toy
                        </span>
                        <span className="text-sm text-slate-900 dark:text-slate-100">
                          {truncateUuid(job.agentId)}
                        </span>
                      </div>
                    </td>

                    {/* Type */}
                    <td className="px-6 py-4">
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {job.type}
                      </span>
                    </td>

                    {/* Duration */}
                    <td className="px-6 py-4">
                      <span className="font-mono text-sm text-slate-500">
                        {durationMs !== null ? duration(durationMs) : "—"}
                      </span>
                    </td>

                    {/* Started */}
                    <td className="px-6 py-4">
                      <span className="text-sm text-slate-500">
                        {relativeTime(job.createdAt)}
                      </span>
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
                          className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 hover:text-primary dark:hover:bg-slate-700"
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
          <span className="text-xs text-slate-500">
            Page {safePage + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"
            >
              <span className="material-symbols-outlined text-lg">chevron_left</span>
            </button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                className={`size-8 rounded-lg text-xs font-bold transition-colors ${
                  i === safePage
                    ? "bg-primary text-white"
                    : "text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                {i + 1}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"
            >
              <span className="material-symbols-outlined text-lg">chevron_right</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
