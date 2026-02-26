"use client"

import Link from "next/link"

import { JobStatusBadge } from "@/components/jobs/job-status-badge"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { useDashboard } from "@/hooks/use-dashboard"
import { relativeTime } from "@/lib/format"

export default function DashboardPage(): React.JSX.Element {
  const { stats, recentJobs, isLoading, error, errorCode, refetch } = useDashboard()

  const cards = [
    { label: "Total Agents", value: stats.totalAgents, icon: "smart_toy", href: "/agents" },
    { label: "Active Jobs", value: stats.activeJobs, icon: "list_alt", href: "/jobs" },
    { label: "Pending Approvals", value: stats.pendingApprovals, icon: "verified_user", href: "/approvals" },
    { label: "Memory Records", value: stats.memoryRecords, icon: "memory", href: "/memory" },
  ] as const

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[28px] text-primary">dashboard</span>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text-main">
          Dashboard
        </h1>
      </div>

      {/* Error banner */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} onRetry={refetch} />}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ label, value, icon, href }) => (
          <Link
            key={label}
            href={href}
            className="group rounded-xl border border-surface-border bg-surface-light p-6 transition-shadow hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                {label}
              </span>
              <span className="material-symbols-outlined text-[20px] text-text-muted group-hover:text-primary transition-colors">
                {icon}
              </span>
            </div>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-16" />
            ) : (
              <p className="mt-2 text-3xl font-bold text-text-main">{value}</p>
            )}
          </Link>
        ))}
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        {/* Recent Activity */}
        <div className="lg:col-span-2">
          <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-text-main">
            Recent Activity
          </h2>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : recentJobs.length === 0 ? (
            <EmptyState
              icon="list_alt"
              title="No jobs yet"
              description="Once agents begin executing tasks, recent activity will appear here."
            />
          ) : (
            <div className="rounded-xl border border-surface-border bg-surface-light overflow-hidden">
              <div className="divide-y divide-surface-border">
                {recentJobs.map((job) => (
                  <div key={job.id} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <span className="material-symbols-outlined text-[18px] text-primary">
                        smart_toy
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-main truncate">
                        {job.agentName}
                        <span className="ml-2 text-text-muted font-normal">{job.type}</span>
                      </p>
                      <p className="text-xs text-text-muted">{relativeTime(job.createdAt)}</p>
                    </div>
                    <JobStatusBadge status={job.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-text-main">
            Quick Actions
          </h2>
          <div className="space-y-3">
            {[
              { label: "View Agents", icon: "smart_toy", href: "/agents" },
              { label: "Review Approvals", icon: "verified_user", href: "/approvals" },
              { label: "Browse Jobs", icon: "list_alt", href: "/jobs" },
              { label: "Search Memory", icon: "memory", href: "/memory" },
              { label: "Content Pipeline", icon: "hub", href: "/pulse" },
            ].map(({ label, icon, href }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-light px-4 py-3 text-sm font-medium text-text-main transition-shadow hover:shadow-md"
              >
                <span className="material-symbols-outlined text-[18px] text-primary">{icon}</span>
                {label}
                <span className="material-symbols-outlined ml-auto text-[16px] text-text-muted">
                  chevron_right
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
