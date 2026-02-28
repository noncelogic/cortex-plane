"use client"

import { useEffect } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { JobDetail, JobLogEntry, JobMetrics, JobStep } from "@/lib/api-client"
import { getJob } from "@/lib/api-client"
import { bytes, duration, relativeTime } from "@/lib/format"

import { JobRetryButton } from "./job-retry-button"
import { JobStatusBadge } from "./job-status-badge"

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepTimeline({ steps }: { steps: JobStep[] }): React.JSX.Element {
  const dotColor = (status: JobStep["status"]) => {
    if (status === "COMPLETED") return "bg-emerald-500"
    if (status === "FAILED") return "bg-red-500"
    if (status === "RUNNING") return "bg-blue-400 animate-pulse"
    return "bg-text-muted"
  }

  const lineColor = (status: JobStep["status"]) => {
    if (status === "COMPLETED") return "bg-emerald-500/30"
    if (status === "FAILED") return "bg-red-500/30"
    return "bg-surface-border"
  }

  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={step.name} className="relative flex gap-4 pb-6 last:pb-0">
          {/* Vertical line */}
          {i < steps.length - 1 && (
            <div className={`absolute left-[9px] top-5 h-full w-0.5 ${lineColor(step.status)}`} />
          )}

          {/* Dot */}
          <div className="relative z-10 mt-1 flex-shrink-0">
            <div
              className={`size-[18px] rounded-full border-2 border-bg-light ${dotColor(step.status)}`}
            />
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-text-main">{step.name}</span>
              {step.duration_ms !== undefined && (
                <span className="font-mono text-xs text-text-muted">
                  {duration(step.duration_ms)}
                </span>
              )}
            </div>
            {step.worker && <span className="text-xs text-text-muted">{step.worker}</span>}
            {step.error && (
              <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {step.error}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function MetricsGrid({ metrics }: { metrics: JobMetrics }): React.JSX.Element {
  const items = [
    {
      label: "CPU",
      value: `${metrics.cpu_percent}%`,
      icon: "memory",
    },
    {
      label: "Memory",
      value: `${metrics.memory_mb} MB`,
      icon: "storage",
    },
    {
      label: "Network I/O",
      value: `${bytes(metrics.network_in_bytes)} / ${bytes(metrics.network_out_bytes)}`,
      icon: "swap_vert",
    },
    {
      label: "Threads",
      value: String(metrics.thread_count),
      icon: "account_tree",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-surface-border bg-secondary p-3">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-text-muted">{item.icon}</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              {item.label}
            </span>
          </div>
          <span className="font-mono text-sm font-bold text-text-main">{item.value}</span>
        </div>
      ))}
    </div>
  )
}

const logLevelColors: Record<JobLogEntry["level"], string> = {
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERR: "text-red-400",
  DEBUG: "text-text-muted",
}

function LogViewer({ logs }: { logs: JobLogEntry[] }): React.JSX.Element {
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-surface-border bg-bg-light p-3 font-mono text-xs">
      {logs.map((log, i) => {
        const time = new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })
        return (
          <div key={i} className="flex gap-2 py-0.5">
            <span className="flex-shrink-0 text-text-muted">{time}</span>
            <span className={`flex-shrink-0 font-bold ${logLevelColors[log.level]}`}>
              [{log.level}]
            </span>
            <span className="text-text-main">{log.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

interface JobDetailDrawerProps {
  jobId: string | null
  onClose: () => void
  onRetried?: () => void
}

export function JobDetailDrawer({
  jobId,
  onClose,
  onRetried,
}: JobDetailDrawerProps): React.JSX.Element | null {
  const { data: apiData, error: apiError } = useApiQuery(
    () => (jobId ? getJob(jobId) : Promise.reject(new Error("no job"))),
    [jobId],
  )

  const job: JobDetail | null = apiData ?? null

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  if (!jobId) return null

  const canRetry =
    job?.status === "FAILED" || job?.status === "TIMED_OUT" || job?.status === "DEAD_LETTER"

  const durationMs =
    job?.duration_ms ??
    (job?.completed_at && job.created_at
      ? new Date(job.completed_at).getTime() - new Date(job.created_at).getTime()
      : null)

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col border-l border-surface-border bg-bg-light shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-surface-border p-6">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-bold text-primary">
                {jobId.slice(0, 8)}...
              </span>
              {job && <JobStatusBadge status={job.status} />}
            </div>
            {job && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">smart_toy</span>
                  {job.agent_name ?? job.agent_id.slice(0, 12)}
                  {job.agent_version && (
                    <span className="text-xs text-text-muted"> {job.agent_version}</span>
                  )}
                </span>
                <span className="rounded-md bg-secondary px-2 py-0.5 text-xs">{job.type}</span>
                {durationMs !== null && (
                  <span className="font-mono text-xs">{duration(durationMs)}</span>
                )}
                <span className="text-xs">{relativeTime(job.created_at)}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary hover:text-text-main"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {job ? (
            <>
              {/* Execution Steps */}
              <section>
                <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                  <span className="material-symbols-outlined text-sm">timeline</span>
                  Execution Steps
                </h3>
                <StepTimeline steps={job.steps} />
              </section>

              {/* Metrics */}
              {job.metrics && (
                <section>
                  <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                    <span className="material-symbols-outlined text-sm">monitoring</span>
                    Resource Metrics
                  </h3>
                  <MetricsGrid metrics={job.metrics} />
                </section>
              )}

              {/* Logs */}
              {job.logs.length > 0 && (
                <section>
                  <h3 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                    <span className="material-symbols-outlined text-sm">article</span>
                    Recent Logs
                  </h3>
                  <LogViewer logs={job.logs} />
                </section>
              )}
            </>
          ) : apiError ? (
            <div className="flex flex-col items-center justify-center py-12">
              <span className="material-symbols-outlined text-3xl text-text-muted">
                error_outline
              </span>
              <span className="mt-3 text-sm font-semibold text-text-main">
                Unable to load job details
              </span>
              <span className="mt-1 text-xs text-text-muted">{apiError}</span>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <span className="material-symbols-outlined animate-spin text-3xl text-text-muted">
                sync
              </span>
              <span className="mt-3 text-sm text-text-muted">Loading job details...</span>
            </div>
          )}
        </div>

        {/* Footer */}
        {job && (
          <div className="flex items-center justify-between border-t border-surface-border p-4">
            <button
              type="button"
              onClick={() => {
                if (!job.logs.length) return
                const lines = job.logs.map(
                  (l) => `${new Date(l.timestamp).toISOString()} [${l.level}] ${l.message}`,
                )
                const blob = new Blob([lines.join("\n")], { type: "text/plain" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = `job-${jobId.slice(0, 8)}-logs.txt`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              }}
              className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-bold text-text-main transition-colors hover:bg-surface-border"
            >
              <span className="material-symbols-outlined text-lg">download</span>
              Download Logs
            </button>
            {canRetry && <JobRetryButton jobId={jobId} variant="full" onRetried={onRetried} />}
          </div>
        )}
      </div>
    </>
  )
}
