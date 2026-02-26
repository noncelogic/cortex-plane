"use client"

import { useEffect } from "react"

import { useApiQuery } from "@/hooks/use-api"
import type { JobDetail, JobLogEntry, JobMetrics, JobStep } from "@/lib/api-client"
import { getJob } from "@/lib/api-client"
import { bytes, duration, relativeTime } from "@/lib/format"

import { JobRetryButton } from "./job-retry-button"
import { JobStatusBadge } from "./job-status-badge"

// ---------------------------------------------------------------------------
// Mock data factory (until API is wired up)
// ---------------------------------------------------------------------------

function mockJobDetail(jobId: string): JobDetail {
  const statuses = ["COMPLETED", "FAILED", "RUNNING"] as const
  const status = statuses[Math.abs(hashCode(jobId)) % statuses.length]!
  const now = Date.now()
  const createdAt = new Date(now - 3_600_000 - Math.random() * 7_200_000).toISOString()
  const durationMs = 45_000 + Math.floor(Math.random() * 120_000)

  const steps: JobStep[] = [
    {
      name: "Initialize Context",
      status: "COMPLETED",
      startedAt: createdAt,
      completedAt: new Date(new Date(createdAt).getTime() + 2_300).toISOString(),
      durationMs: 2_300,
      worker: "worker-01",
    },
    {
      name: "Load Agent State",
      status: "COMPLETED",
      startedAt: new Date(new Date(createdAt).getTime() + 2_300).toISOString(),
      completedAt: new Date(new Date(createdAt).getTime() + 5_100).toISOString(),
      durationMs: 2_800,
      worker: "worker-01",
    },
    {
      name: "Execute Inference",
      status: status === "FAILED" ? "FAILED" : "COMPLETED",
      startedAt: new Date(new Date(createdAt).getTime() + 5_100).toISOString(),
      completedAt:
        status === "RUNNING"
          ? undefined
          : new Date(new Date(createdAt).getTime() + 38_000).toISOString(),
      durationMs: status === "RUNNING" ? undefined : 32_900,
      worker: "worker-02",
      error: status === "FAILED" ? "Model inference timeout after 30s — upstream provider returned 504 Gateway Timeout" : undefined,
    },
    {
      name: "Post-Process Results",
      status: status === "FAILED" ? "PENDING" : status === "RUNNING" ? "PENDING" : "COMPLETED",
      durationMs: status === "COMPLETED" ? 1_200 : undefined,
      worker: status === "COMPLETED" ? "worker-01" : undefined,
    },
    {
      name: "Persist Checkpoint",
      status: status === "FAILED" ? "PENDING" : status === "RUNNING" ? "PENDING" : "COMPLETED",
      durationMs: status === "COMPLETED" ? 800 : undefined,
      worker: status === "COMPLETED" ? "worker-01" : undefined,
    },
  ]

  const metrics: JobMetrics = {
    cpuPercent: 34 + Math.floor(Math.random() * 40),
    memoryMb: 256 + Math.floor(Math.random() * 512),
    networkInBytes: 1_200_000 + Math.floor(Math.random() * 5_000_000),
    networkOutBytes: 400_000 + Math.floor(Math.random() * 2_000_000),
    threadCount: 4 + Math.floor(Math.random() * 12),
  }

  const logs: JobLogEntry[] = [
    { timestamp: createdAt, level: "INFO", message: "Job started — initializing execution context" },
    { timestamp: new Date(new Date(createdAt).getTime() + 1_000).toISOString(), level: "INFO", message: "Agent state loaded from checkpoint crc32=0x4a2b1c3d" },
    { timestamp: new Date(new Date(createdAt).getTime() + 2_500).toISOString(), level: "DEBUG", message: "Resolved tool bindings: [web_search, code_exec, file_read]" },
    { timestamp: new Date(new Date(createdAt).getTime() + 5_200).toISOString(), level: "INFO", message: "Inference request dispatched to model provider" },
    { timestamp: new Date(new Date(createdAt).getTime() + 12_000).toISOString(), level: "WARN", message: "Inference latency exceeds p95 threshold (12.4s > 8.0s)" },
    ...(status === "FAILED"
      ? [
          {
            timestamp: new Date(new Date(createdAt).getTime() + 30_000).toISOString(),
            level: "ERR" as const,
            message: "Model inference timeout after 30s — upstream provider returned 504 Gateway Timeout",
          },
          {
            timestamp: new Date(new Date(createdAt).getTime() + 30_100).toISOString(),
            level: "ERR" as const,
            message: "Job failed — marking as FAILED and scheduling for retry evaluation",
          },
        ]
      : [
          {
            timestamp: new Date(new Date(createdAt).getTime() + 35_000).toISOString(),
            level: "INFO" as const,
            message: "Inference completed successfully — 2,847 tokens generated",
          },
          {
            timestamp: new Date(new Date(createdAt).getTime() + 38_000).toISOString(),
            level: "INFO" as const,
            message: "Checkpoint persisted — job completed",
          },
        ]),
  ]

  return {
    id: jobId,
    agentId: "agt-" + jobId.slice(0, 8),
    agentName: ["Atlas Navigator", "CodeWeaver", "DataSentinel", "TaskRunner"][
      Math.abs(hashCode(jobId)) % 4
    ],
    agentVersion: "v1." + (Math.abs(hashCode(jobId)) % 10),
    status,
    type: ["inference", "tool-call", "pipeline", "batch"][Math.abs(hashCode(jobId)) % 4]!,
    createdAt,
    updatedAt: new Date(new Date(createdAt).getTime() + durationMs).toISOString(),
    completedAt:
      status === "RUNNING"
        ? undefined
        : new Date(new Date(createdAt).getTime() + durationMs).toISOString(),
    durationMs,
    steps,
    metrics,
    logs,
  }
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

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
            <div
              className={`absolute left-[9px] top-5 h-full w-0.5 ${lineColor(step.status)}`}
            />
          )}

          {/* Dot */}
          <div className="relative z-10 mt-1 flex-shrink-0">
            <div className={`size-[18px] rounded-full border-2 border-bg-light ${dotColor(step.status)}`} />
          </div>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-text-main">{step.name}</span>
              {step.durationMs !== undefined && (
                <span className="font-mono text-xs text-text-muted">
                  {duration(step.durationMs)}
                </span>
              )}
            </div>
            {step.worker && (
              <span className="text-xs text-text-muted">{step.worker}</span>
            )}
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
      value: `${metrics.cpuPercent}%`,
      icon: "memory",
    },
    {
      label: "Memory",
      value: `${metrics.memoryMb} MB`,
      icon: "storage",
    },
    {
      label: "Network I/O",
      value: `${bytes(metrics.networkInBytes)} / ${bytes(metrics.networkOutBytes)}`,
      icon: "swap_vert",
    },
    {
      label: "Threads",
      value: String(metrics.threadCount),
      icon: "account_tree",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-surface-border bg-secondary p-3"
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-text-muted">
              {item.icon}
            </span>
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
  // Attempt real API fetch; fall back to mock
  const { data: apiData, error: apiError } = useApiQuery(
    () => (jobId ? getJob(jobId) : Promise.reject(new Error("no job"))),
    [jobId],
  )

  // Use mock when API is not available
  const job: JobDetail | null =
    apiData ?? (jobId && apiError ? mockJobDetail(jobId) : apiData)

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
    job?.durationMs ??
    (job?.completedAt && job.createdAt
      ? new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()
      : null)

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

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
                  {job.agentName ?? job.agentId.slice(0, 12)}
                  {job.agentVersion && (
                    <span className="text-xs text-text-muted"> {job.agentVersion}</span>
                  )}
                </span>
                <span className="rounded-md bg-secondary px-2 py-0.5 text-xs">
                  {job.type}
                </span>
                {durationMs !== null && (
                  <span className="font-mono text-xs">{duration(durationMs)}</span>
                )}
                <span className="text-xs">{relativeTime(job.createdAt)}</span>
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
              className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-bold text-text-main transition-colors hover:bg-surface-border"
            >
              <span className="material-symbols-outlined text-lg">download</span>
              Download Logs
            </button>
            {canRetry && (
              <JobRetryButton
                jobId={jobId}
                variant="full"
                onRetried={onRetried}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
